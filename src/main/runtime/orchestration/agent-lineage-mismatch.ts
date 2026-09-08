// S10-21a C6/C6a/C6b (design v3.2 §2.3, §2.6, §1.6; errata 5(l)/5(m)/5(n)/5(aa)/5(ab); D-R107;
// D-R108; Ruling 34 Addendum 18/19) + S10-21c B4 (design §2 S3/S5, OD-B / INV-P-020 amendment #1,
// UNRATIFIED): Layer 1's own detection surface — a live pane's hook-reported session id compared
// against its own agent_launch_sessions row (never current_sessions, and never a peer pane's row:
// §2.3's continuity rule reads agent_launch_sessions as the sole source of lineage truth).
//
// [S10-21c B4] THE PRODUCTION RECONCILIATION FENCE IS FOUR CONJUNCTS, and the module is no longer
// pure DB: conjunct (iii) is one filesystem read, so the function is async. Every OTHER conjunct
// is a synchronous DB fact re-read AFTER that await, in the same tick as the write it gates
// (`applyLiveReportReconciliation` / `bootstrapRowFromLiveReport` both re-read) — nothing decided
// before the await can authorise a write after it.
//   (i)   anchorHostVerified — the RUNTIME's own launch-token verdict for this exact pane,
//         captured at hook ingestion (server.ts's recordCurrentAuthorityObservation ->
//         paneLaunchAuthorityVerifier -> orca-runtime.ts#verifyLivePaneLaunchTokenHash, which
//         since S1 also requires a live pty whose <ptyId>:<incarnationId> matches the binding
//         recorded at mint, on the caller's own partition). STRICTLY STRONGER than the
//         `anchorCorroborated` this replaced: that one is satisfiable by the hook server's OWN
//         persisted/hydrated commitment cache (server.ts's isCorroboratedAuthority continuity
//         arms), which is hook-derived, not host-derived.
//   (ii)  EXACT pane-key match. The row lookup is by SUFFIX (newestLaunchForPaneSuffix,
//         D-R107 MEDIUM-1) and can resolve a SIBLING pane's row; the pre-B4 code then rotated
//         `row.pane_key`. Refusing unless `row.pane_key === params.paneKey` closes that
//         pre-existing cross-pane door. Same requirement on S5's `getAgentByPaneKey`, which is
//         suffix-scoped too (derived-agent-rows.ts:22-33) — the exact match is enforced HERE.
//   (iii) the REPORTED session names a transcript that actually carries a turn (S4's
//         resolveResumeTranscript, reused verbatim). `{coverage:'uncovered'}` REFUSES and carries
//         S4's own `resume_preflight_uncovered <agentType>` code into the audit.
//   (iv)  successor uniqueness — current_sessions UNIQUE(host_id, session_id), enforced INSIDE
//         recordSelfReportRotation / recordLaunch, never re-derived here and never pre-checked.
// Conjunct 4 of the pre-B4 fence (`sessionStartSource === 'fork'`) is DROPPED, not loosened, per
// the chair synthesis ("Drop conjunct 4") and design §2 S3. The value is still carried and is now
// RECORDED in the 'reconciled' audit's reason code as evidence rather than used as a gate.
//
// [Ruling 34 Addendum 19 / errata 5(ab)] §1.6 conjunct 2 (the report's previous id equals the
// pane's own last-recorded id) is TAUTOLOGICAL on the live path: no Claude Code hook payload
// carries a previous-session field at all, so the only value a caller could ever supply for it
// is this function's OWN `row.session_id` read back at itself — never independent corroboration.
//
// Any conjunct failing, INCLUDING a conjunct-(iv) collision recordSelfReportRotation itself
// refuses -> the foreign-id mismatch alarm (T31/T33): a `session_identity_mismatch` audit row —
// UNCONDITIONAL (Addendum 18), UNLESS [Addendum 18(iii)/19, D-R108 R1] the pane's newest
// admission audit of ANY verb, THIS launch generation, resolved by pane suffix, is itself the
// UNRECORDED outcome — then `unrecorded_launch`, not a contest. This module never touches
// current_sessions directly; only recordSelfReportRotation's / recordLaunch's own upserts do.
import type Database from '../../sqlite/sync-database'
import {
  newestLaunchForPaneSuffix,
  recordLaunch,
  recordSelfReportRotation,
  setLaunchAgentId,
  type AgentLaunchSessionRow
} from './agent-launch-sessions'
import { getAgentByPaneKey } from './derived-agent-rows'
import type { AgentRow } from './agent-directory-types'
import { writeAgentAudit } from './agent-audit-log'
import {
  MISMATCH_AUDIT_VERB,
  newestUnrecordedAdmissionThisGeneration,
  raiseMismatchAlarm
} from './agent-lineage-contest-audit'

export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'fork'

/** [S10-21c B4] S4's landed three-state resolver verdict (restore-sweep-types.ts:70-73), reused
 * verbatim: a hit, the "this resolver does not cover that agentType yet" third state, or a miss. */
export type LiveReportTranscriptVerdict =
  | { path: string; hasTurn: boolean }
  | { coverage: 'uncovered' }
  | null

/** [S10-21c B4, design §2 S3/S5 conjunct (iii)] `resolve-resume-transcript.ts#resolveResumeTranscript`,
 * injected rather than imported so this module keeps no filesystem dependency of its own and the
 * conjunct is stubbable in one place. */
export type ResolveLiveReportTranscript = (
  agentType: string,
  sessionId: string
) => Promise<LiveReportTranscriptVerdict>

export type LiveHookReportMismatchParams = {
  hostId: string
  paneKey: string
  /** The session id the pane's own live hook report carries right now. */
  reportedSessionId: string
  /** [pre-B4 conjunct 1] `isCorroboratedAuthority`'s ACTUAL, captured verdict for this hook report
   * (server.ts's `anchorCorroborated`, stamped at ingestion — never re-derived later). No longer
   * a rotation conjunct: it gates only `raiseMismatchAlarm`'s uncorroborated-claimant attribution
   * (F2/D-R125), which is unchanged. */
  anchorCorroborated: boolean
  /** [S10-21c B4, design §2 S3 conjunct (i)] The RUNTIME's own launch-token verdict for this pane
   * (server.ts's `anchorHostVerified`, from `paneLaunchAuthorityVerifier` ALONE), stamped at the
   * same ingestion point and never re-derived. Absent/false is read as unverified everywhere. */
  anchorHostVerified: boolean
  /** [D-R107 fix item 8] The explicit SessionStart `source` value this generation observed for
   * this pane, when any. NO LONGER A CONJUNCT (design §2 S3 drops it); recorded in the
   * 'reconciled' audit's reason code so the evidence survives without gating. */
  sessionStartSource: SessionStartSource | undefined
  /** [S10-21a C6b, Ruling 34 Addendum 19 / D-R108 R1(b)] The caller's OWN current launch
   * generation (`runtime.getLaunchGenerationId()`) — binds the `unrecorded_launch` downgrade to
   * this generation: a stale prior-generation launch row (or the admission history attached to
   * it) can never suppress a genuine contest in the CURRENT generation. */
  launchGeneration: string
  /** [S10-21c B4, design §2 S5] The agent type the reporting pane's own hook entry names, and the
   * execution host the report arrived on (local, or the relay connection the hook server itself
   * stamped — never a value the payload can choose). BOTH are needed only to INSERT a bootstrap
   * row; S3's reconciliation reuses the row's own columns and ignores them. Absent -> S5 cannot
   * fire (fail-closed: no row is ever written from a guessed agent type or partition). */
  reportedAgentType?: string
  executionHostId?: string
}

export type LiveHookReportMismatchResult =
  | { kind: 'match' }
  | { kind: 'no_row' }
  /** [S10-21c B4, design §2 S3] Replaces the pre-B4 `{kind:'rotated'}`: after the conjunct-4 drop
   * there is exactly ONE rotation mechanism left, and it is this one — the result kind, the
   * evidence value ('live_report') and the audit outcome ('reconciled') now name the same event. */
  | { kind: 'reconciled'; row: AgentLaunchSessionRow }
  /** [S10-21c B4, design §2 S5] The pane had no launch row and earned its first one. */
  | { kind: 'bootstrapped'; row: AgentLaunchSessionRow }
  /** [S10-21c B4b, D-R152-b4 finding 2] The `no_row` arm reached conjunct (iii) or (iv) and one
   * of them refused (an uncovered/absent transcript, or a session id another pane already holds)
   * — DISTINCT from the ordinary `no_row` a routine/unregistered/unverified report returns, so
   * the caller can notice it once instead of leaving a persistently-refused bootstrap silent. */
  | { kind: 'bootstrap_refused'; reason: string }
  // [F2, D-R125] `attributedPaneKey`, present ONLY when it differs from `params.paneKey` (an
  // uncorroborated report naming a pane other than the row's own owner — an unauthenticated
  // claim): the pane the audit was actually charged to (`row.pane_key`), so the caller
  // (session-identity-mismatch-alarm.ts) can route any notice there instead of the claimant.
  | { kind: 'foreign_mismatch'; attributedPaneKey?: string }
  // [Ruling 34 Addendum 18(iii)/19] Honest floors do not false-alarm: the pane's newest
  // admission audit of ANY verb, THIS generation, was itself the UNRECORDED outcome — the
  // disagreement is fully explained by "nothing was ever recorded to agree with", not a contest.
  | { kind: 'unrecorded_launch'; reason: string }

const BOOTSTRAP_AUDIT_VERB = 'session_identity_bootstrap'

/** [S10-21c B4b, D-R152-b4 finding 2] Conjunct (iii) is one recursive filesystem walk
 * (resolve-resume-transcript.ts), and the alarm batch redrives every identity on EVERY accepted
 * hook status change — a pane whose reported id never resolves would otherwise pay one full walk
 * per hook event, forever, invisibly (the audit dedupe already silences the repeat). Memoized by
 * (host, pane, reported id) for the CURRENT launch generation only — cleared wholesale on a
 * generation change rather than keyed by it, so the map never carries a stale generation's
 * entries. NEVER holds a positive verdict: a transcript may gain its first turn later, and a
 * cached `true` would make that permanently unobservable. */
const NEGATIVE_TRANSCRIPT_VERDICT_CACHE_MAX = 512
let negativeTranscriptVerdictGeneration: string | undefined
const negativeTranscriptVerdictCache = new Map<string, { ok: false; note?: string }>()

async function checkTranscriptConjunctMemoized(
  resolveResumeTranscript: ResolveLiveReportTranscript,
  agentType: string,
  params: Pick<
    LiveHookReportMismatchParams,
    'hostId' | 'paneKey' | 'reportedSessionId' | 'launchGeneration'
  >
): Promise<{ ok: true } | { ok: false; note?: string }> {
  if (negativeTranscriptVerdictGeneration !== params.launchGeneration) {
    negativeTranscriptVerdictGeneration = params.launchGeneration
    negativeTranscriptVerdictCache.clear()
  }
  const key = `${params.hostId}:${params.paneKey}:${params.reportedSessionId}`
  const cached = negativeTranscriptVerdictCache.get(key)
  if (cached) {
    return cached
  }
  const verdict = await checkTranscriptConjunct(
    resolveResumeTranscript,
    agentType,
    params.reportedSessionId
  )
  if (!verdict.ok) {
    if (negativeTranscriptVerdictCache.size >= NEGATIVE_TRANSCRIPT_VERDICT_CACHE_MAX) {
      const oldest = negativeTranscriptVerdictCache.keys().next().value
      if (oldest !== undefined) {
        negativeTranscriptVerdictCache.delete(oldest)
      }
    }
    negativeTranscriptVerdictCache.set(key, verdict)
  }
  return verdict
}

/** Test-only: the memo cache above is module-scoped so it survives across `it()` blocks in the
 * same file — tests reusing a (host, pane, session id) between cases must reset it first. */
export function resetNegativeTranscriptVerdictCacheForTests(): void {
  negativeTranscriptVerdictGeneration = undefined
  negativeTranscriptVerdictCache.clear()
}

/** §2.3/§2.6/§1.6 + §2 S3/S5, Layer 1. Compares a live pane's hook-reported session id against
 * its own newest `agent_launch_sessions` row (resolved by pane SUFFIX, D-R107 MEDIUM-1). A
 * disagreement satisfying the four conjuncts in this file's header is a legitimate live-report
 * reconciliation (T30, no alarm); NO row at all plus the same conjuncts and a registered,
 * non-derived, non-quarantined agent row on the SAME pane is a bootstrap (S5); a disagreement on
 * a pane whose newest admission outcome, THIS generation, was UNRECORDED is `unrecorded_launch`
 * (Addendum 18(iii)/19); any other disagreement is a foreign-id mismatch (T31/T33) — audited
 * UNCONDITIONALLY (Addendum 18), row unchanged. */
export async function evaluateLiveHookReportMismatch(
  db: Database.Database,
  params: LiveHookReportMismatchParams,
  resolveResumeTranscript: ResolveLiveReportTranscript
): Promise<LiveHookReportMismatchResult> {
  let row = newestLaunchForPaneSuffix(db, params.hostId, params.paneKey)
  if (!row) {
    return await bootstrapRowFromLiveReport(db, params, resolveResumeTranscript)
  }
  if (row.session_id === params.reportedSessionId) {
    return { kind: 'match' }
  }

  // Conjuncts (i) and (ii) are cheap, synchronous and cross-pane-decisive, so they run BEFORE the
  // filesystem read: a report that could never reconcile never pays for a transcript resolve, and
  // a sibling-suffix report never reaches the write path at all.
  let refusalNote: string | undefined
  if (params.anchorHostVerified && row.pane_key === params.paneKey) {
    const transcript = await checkTranscriptConjunctMemoized(
      resolveResumeTranscript,
      row.agent_type,
      params
    )
    // Everything past the await is re-derived from a same-tick read. The row above is now stale
    // evidence: across one filesystem read it can have been retired, superseded by a newer row
    // for a different pane on the same suffix, or already reconciled by a concurrent report. It
    // may gate neither the write below nor the alarm at the bottom, which is why `row` is
    // reassigned rather than merely re-checked.
    const fresh = newestLaunchForPaneSuffix(db, params.hostId, params.paneKey)
    if (!fresh) {
      return { kind: 'no_row' }
    }
    if (fresh.session_id === params.reportedSessionId) {
      return { kind: 'match' }
    }
    // [S10-21c B4b, D-R152-b4 finding 4] The transcript was resolved against the PRE-await
    // `row.agent_type`; refuse if the same-tick re-read's row now names a different agent type
    // (fail-closed) rather than land a session validated under one type onto a row of another.
    if (transcript.ok && fresh.pane_key === params.paneKey && fresh.agent_type === row.agent_type) {
      const reconciled = applyLiveReportReconciliation(db, params, fresh)
      if (reconciled) {
        return reconciled
      }
    } else if (!transcript.ok) {
      refusalNote = transcript.note
    }
    row = fresh
  }

  const unrecorded = newestUnrecordedAdmissionThisGeneration(db, params, row)
  if (unrecorded) {
    writeAgentAudit(db, {
      agentId: row.agent_id,
      actorPaneKey: params.paneKey,
      actorHostId: params.hostId,
      verb: MISMATCH_AUDIT_VERB,
      outcome: 'unrecorded_launch',
      reasonCode: `recorded=${row.session_id} reported=${params.reportedSessionId} admission_reason=${unrecorded}`
    })
    return { kind: 'unrecorded_launch', reason: unrecorded }
  }

  const attributedPaneKey = raiseMismatchAlarm(db, row, params, refusalNote)
  return attributedPaneKey === params.paneKey
    ? { kind: 'foreign_mismatch' }
    : { kind: 'foreign_mismatch', attributedPaneKey }
}

/** [S10-21c B4, design §2 S3/S5 conjunct (iii)] `{path, hasTurn:true}` is real. `{coverage}` is
 * S4's third state — the resolver does not cover this agent type yet — and REFUSES here (unlike
 * the sweep, which only notes it and proceeds: the sweep is resuming an id the HOST authored,
 * while this path is deciding whether to believe an id the PANE authored, so an unverifiable
 * transcript is the difference between a weaker check and no check). A miss or a turn-less
 * transcript refuses with the alarm path unchanged (no note). */
async function checkTranscriptConjunct(
  resolveResumeTranscript: ResolveLiveReportTranscript,
  agentType: string,
  sessionId: string
): Promise<{ ok: true } | { ok: false; note?: string }> {
  const transcript = await resolveResumeTranscript(agentType, sessionId)
  if (transcript !== null && 'coverage' in transcript) {
    return { ok: false, note: `resume_preflight_uncovered ${agentType}` }
  }
  if (!transcript || !transcript.hasTurn) {
    return { ok: false }
  }
  return { ok: true }
}

/** [S10-21c B4, design §2 S3] Conjunct (iv) plus the write. `row` MUST be the caller's same-tick
 * re-read (there is no await between that read and this write, which is the whole point).
 * `undefined` means "not reconciled" and falls through to the alarm — including the two typed
 * refusals recordSelfReportRotation itself returns (`foreign_session_id`, T33: the successor is
 * another pane's live session; `no_matching_launch_row`: the row was concurrently retired). The
 * collision is never pre-checked here: current_sessions UNIQUE(host_id, session_id) is the one
 * successor fence and it adjudicates inside that call's own transaction. */
function applyLiveReportReconciliation(
  db: Database.Database,
  params: LiveHookReportMismatchParams,
  row: AgentLaunchSessionRow
): LiveHookReportMismatchResult | undefined {
  const rotation = recordSelfReportRotation(db, {
    hostId: params.hostId,
    // The row's OWN key, which conjunct (ii) has just proven equal to the reporting pane's.
    paneKey: row.pane_key,
    previousSessionId: row.session_id,
    sessionId: params.reportedSessionId,
    launchGeneration: row.launch_generation,
    // [R87] The REPORT's own partition when known, not the row's possibly-stale one — a report
    // arriving on a different partition than the row currently claims should re-stamp it.
    executionHostId: params.executionHostId ?? row.execution_host_id,
    evidence: 'live_report'
  })
  if (!rotation.ok) {
    return undefined
  }
  // Reconciliation is NOT silent (design §2 S3): the detector keeps its information, it just
  // stops being permanent. `sessionStartSource` rides the reason code as evidence now that it is
  // no longer a gate.
  writeAgentAudit(db, {
    agentId: rotation.row.agent_id,
    actorPaneKey: params.paneKey,
    actorHostId: params.hostId,
    verb: MISMATCH_AUDIT_VERB,
    outcome: 'reconciled',
    reasonCode:
      `recorded=${row.session_id} reported=${params.reportedSessionId} ` +
      `source=${params.sessionStartSource ?? 'none'}`
  })
  return { kind: 'reconciled', row: rotation.row }
}

/** [S10-21c B4, design §2 S5] The `no_row` arm: a REGISTERED, non-derived, non-quarantined pane
 * with no launch row earns its first one from its own host-verified live report — the shape
 * `vps-services` is in today, permanently exiled by the sweep's `sweep_no_launch_row`. Every
 * conjunct in this file's header applies, plus the agent row's own three predicates. Two
 * host-owned facts the hook payload cannot choose are required and never guessed: the execution
 * host the report arrived on, and the agent type its status entry names (which conjunct (iii)
 * then binds — an unknown type is `{coverage:'uncovered'}` and refuses). `supersedePaneKey` stays
 * unset: it is restore-only by contract (INV-P-021), so current_sessions UNIQUE remains the sole
 * cross-pane fence. Anything short of all of it returns the pre-B4 `{kind:'no_row'}` unchanged. */
async function bootstrapRowFromLiveReport(
  db: Database.Database,
  params: LiveHookReportMismatchParams,
  resolveResumeTranscript: ResolveLiveReportTranscript
): Promise<LiveHookReportMismatchResult> {
  const agentType = params.reportedAgentType
  const executionHostId = params.executionHostId
  if (!params.anchorHostVerified || !agentType || !executionHostId) {
    return { kind: 'no_row' }
  }
  // `getAgentByPaneKey` matches by pane SUFFIX (derived-agent-rows.ts:22-33) — it can return a
  // SIBLING pane's registered row, so conjunct (ii)'s exact match is enforced by THIS line and
  // nowhere else. `derived`/`quarantined` keep the ledger free of rows for ordinary terminals and
  // for a row an operator has already fenced off.
  const agent = getAgentByPaneKey(db, params.hostId, params.paneKey)
  if (!isBootstrappableAgentRow(agent, params)) {
    return { kind: 'no_row' }
  }
  const transcript = await checkTranscriptConjunctMemoized(
    resolveResumeTranscript,
    agentType,
    params
  )
  if (!transcript.ok) {
    const reason = transcript.note ?? `resume_target_absent session ${params.reportedSessionId}`
    writeBootstrapAudit(db, params, agent.id, 'refused', reason)
    return { kind: 'bootstrap_refused', reason }
  }
  // Same-tick re-reads (the transcript resolve above is an await, so BOTH facts read before it
  // are stale by now): a launch row that appeared across the await means this is no longer the
  // no_row arm at all, and an agent row that was retired, quarantined or re-keyed in that window
  // must not license a write either. Only a fresh read may gate the INSERT below.
  if (newestLaunchForPaneSuffix(db, params.hostId, params.paneKey)) {
    return { kind: 'no_row' }
  }
  const freshAgent = getAgentByPaneKey(db, params.hostId, params.paneKey)
  // [S10-21c B4b, D-R152-b4 finding 3] Gate with the RE-READ value, not the pre-await `agent` —
  // ids churn on retire/re-register, and binding the new row's launch under an old, now-
  // tombstoned agent id would leave a stale row holding the current_sessions UNIQUE fence
  // forever once the current agent later retires (deleteLaunchRowsForAgent then never matches).
  if (!isBootstrappableAgentRow(freshAgent, params) || freshAgent.id !== agent.id) {
    return { kind: 'no_row' }
  }
  const recorded = recordLaunch(db, {
    hostId: params.hostId,
    paneKey: params.paneKey,
    agentType,
    sessionId: params.reportedSessionId,
    launchGeneration: params.launchGeneration,
    executionHostId,
    evidence: 'self_report_bootstrap'
  })
  if (!recorded.ok) {
    // conjunct (iv): another pane currently holds this session. Never absorbed, never superseded.
    const reason = `foreign_session_id ${params.reportedSessionId}`
    writeBootstrapAudit(db, params, freshAgent.id, 'refused', reason)
    return { kind: 'bootstrap_refused', reason }
  }
  setLaunchAgentId(db, { seq: recorded.row.seq }, freshAgent.id)
  writeBootstrapAudit(
    db,
    params,
    freshAgent.id,
    'bootstrapped',
    `session=${params.reportedSessionId} agent_type=${agentType}`
  )
  return { kind: 'bootstrapped', row: { ...recorded.row, agent_id: freshAgent.id } }
}

/** [S10-21c B4, design §2 S5] The three agent-row predicates, plus conjunct (ii)'s exact match.
 * `getAgentByPaneKey` matches by pane SUFFIX (derived-agent-rows.ts:22-33) and its own WHERE
 * clause already excludes tombstoned rows and null pane keys; the EXACT match is what this
 * function adds, and it is the only thing standing between a sibling pane's registration and a
 * bootstrap on this one. Declared as a predicate so the pre-await gate and the same-tick re-read
 * before the INSERT are provably the same test. */
function isBootstrappableAgentRow(
  agent: AgentRow | undefined,
  params: LiveHookReportMismatchParams
): agent is AgentRow {
  return (
    agent !== undefined &&
    agent.pane_key === params.paneKey &&
    agent.derived === 0 &&
    agent.quarantined === 0
  )
}

/** [S10-21c B4] Deduped exactly as `raiseMismatchAlarm` dedupes (Ruling 34 Addendum 20): identical
 * noise is silenced, any NEW fact still audits. Needed here specifically because a REFUSED
 * bootstrap repeats for as long as the pane keeps reporting — unlike the mismatch alarm, which
 * stops once the row agrees — so an unconditional row per hook report would flood the ledger. */
function writeBootstrapAudit(
  db: Database.Database,
  params: LiveHookReportMismatchParams,
  agentId: string,
  outcome: string,
  reasonCode: string
): void {
  const newest = db
    .prepare(
      `SELECT outcome, reason_code FROM agent_audit
         WHERE actor_pane_key = ? AND verb = ?
         ORDER BY seq DESC LIMIT 1`
    )
    .get(params.paneKey, BOOTSTRAP_AUDIT_VERB) as
    | { outcome: string; reason_code: string | null }
    | undefined
  if (newest?.outcome === outcome && newest.reason_code === reasonCode) {
    return
  }
  writeAgentAudit(db, {
    agentId,
    actorPaneKey: params.paneKey,
    actorHostId: params.hostId,
    verb: BOOTSTRAP_AUDIT_VERB,
    outcome,
    reasonCode
  })
}
