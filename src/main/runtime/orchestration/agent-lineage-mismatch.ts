// S10-21a C6/C6a/C6b (design v3.2 §2.3, §2.6, §1.6; errata 5(l)/5(m)/5(n)/5(aa)/5(ab); D-R107;
// D-R108; Ruling 34 Addendum 18/19): Layer 1's own detection surface — a live pane's
// hook-reported session id compared against its own agent_launch_sessions row (never
// current_sessions, and never a peer pane's row: §2.3's continuity rule reads
// agent_launch_sessions as the sole source of lineage truth). This module is pure DB: the caller
// supplies the already-verified anchor/shape conjuncts (1: launch-token anchor, per
// verifyLivePaneLaunchTokenHash, captured as `anchorCorroborated` at hook-ingestion time —
// server.ts's `recordCurrentAuthorityObservation`; 4: the SessionStart `source` value Claude Code
// itself reported) — this file has no runtime handle to derive those itself, matching
// agent-restore-rebind.ts's own split between pure predicate and runtime-supplied evidence
// (C4a/C5).
//
// [Ruling 34 Addendum 19 / errata 5(ab)] §1.6 conjunct 2 (the report's previous id equals the
// pane's own last-recorded id) is TAUTOLOGICAL on the live path: no Claude Code hook payload
// carries a previous-session field at all, so the only value a caller could ever supply for it
// is this function's OWN `row.session_id` read back at itself — never independent corroboration.
// This function therefore no longer takes a caller-supplied `reportedPreviousSessionId` at all;
// it derives the value internally from `row.session_id` for the one shape that can ever need it
// (a `fork` report). THE PRODUCTION ROTATION FENCE IS CONJUNCTS 1 + 3 + 4:
//   1. anchorCorroborated — caller-supplied (isCorroboratedAuthority's captured verdict)
//   3. successor uniqueness — enforced by recordSelfReportRotation's current_sessions
//                              UNIQUE(host_id, session_id) violation, not re-checked here
//   4. sessionStartSource === 'fork' — [D-R107 fix item 8] the ONE measured rotation trigger
//      (errata 5(u)); 'startup'/'resume'/'clear' never satisfy this conjunct.
//
// All three hold -> recordSelfReportRotation (T30). Any conjunct fails, INCLUDING a conjunct-3
// collision recordSelfReportRotation itself refuses -> the foreign-id mismatch alarm (T31/T33):
// a `session_identity_mismatch` audit row — UNCONDITIONAL (Addendum 18, correcting Ruling 34
// Addendum 17's C6 error that bundled the audit under the same clamp as the notice), UNLESS
// [Ruling 34 Addendum 18(iii)/19, D-R108 R1] the pane's newest admission audit of ANY verb, THIS
// launch generation, resolved by pane suffix, is itself the UNRECORDED outcome — then
// `unrecorded_launch`, not a contest. This module never touches current_sessions directly; only
// recordSelfReportRotation's own upsert does, on the accepted rotation path.
import type Database from '../../sqlite/sync-database'
import {
  newestLaunchForPaneSuffix,
  recordSelfReportRotation,
  type AgentLaunchSessionRow
} from './agent-launch-sessions'
import { paneSuffix } from './agent-restore-rebind-predicate'
import { writeAgentAudit } from './agent-audit-log'
import { ADMISSION_AUDIT_VERBS } from '../../ipc/agent-launch-admission-support'

export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'fork'

export type LiveHookReportMismatchParams = {
  hostId: string
  paneKey: string
  /** The session id the pane's own live hook report carries right now. */
  reportedSessionId: string
  /** Conjunct 1: `isCorroboratedAuthority`'s ACTUAL, captured verdict for this hook report
   * (server.ts's `anchorCorroborated`, stamped at ingestion — never re-derived later). */
  anchorCorroborated: boolean
  /** Conjunct 4 [D-R107 fix item 8]: the explicit SessionStart `source` value this generation
   * observed for this pane, when any — undefined when no SessionStart was observed at all. */
  sessionStartSource: SessionStartSource | undefined
  /** [S10-21a C6b, Ruling 34 Addendum 19 / D-R108 R1(b)] The caller's OWN current launch
   * generation (`runtime.getLaunchGenerationId()`) — binds the `unrecorded_launch` downgrade to
   * this generation: a stale prior-generation launch row (or the admission history attached to
   * it) can never suppress a genuine contest in the CURRENT generation. */
  launchGeneration: string
}

export type LiveHookReportMismatchResult =
  | { kind: 'match' }
  | { kind: 'no_row' }
  | { kind: 'rotated'; row: AgentLaunchSessionRow }
  | { kind: 'foreign_mismatch' }
  // [Ruling 34 Addendum 18(iii)/19] Honest floors do not false-alarm: the pane's newest
  // admission audit of ANY verb, THIS generation, was itself the UNRECORDED outcome — the
  // disagreement is fully explained by "nothing was ever recorded to agree with", not a contest.
  | { kind: 'unrecorded_launch'; reason: string }

/** §2.3/§2.6/§1.6, Layer 1. Compares a live pane's hook-reported session id against its own
 * newest `agent_launch_sessions` row (resolved by pane SUFFIX, D-R107 MEDIUM-1 — identity is by
 * suffix everywhere else in this design). A disagreement satisfying conjuncts 1+3+4 (conjunct 2
 * is tautological here, errata 5(ab) — see the file header) is a legitimate self-report rotation
 * (T30, no alarm); a disagreement on a pane whose newest admission outcome, THIS generation, was
 * UNRECORDED is `unrecorded_launch` (Addendum 18(iii)/19); any other disagreement is a
 * foreign-id mismatch (T31/T33) — audited UNCONDITIONALLY (Addendum 18), row unchanged. */
export function evaluateLiveHookReportMismatch(
  db: Database.Database,
  params: LiveHookReportMismatchParams
): LiveHookReportMismatchResult {
  const row = newestLaunchForPaneSuffix(db, params.hostId, params.paneKey)
  if (!row) {
    return { kind: 'no_row' }
  }
  if (row.session_id === params.reportedSessionId) {
    return { kind: 'match' }
  }

  const conjunct1 = params.anchorCorroborated
  const conjunct4 = params.sessionStartSource === 'fork'

  if (conjunct1 && conjunct4) {
    // Conjunct 2 [errata 5(ab)]: derived from `row.session_id` itself — the only value that
    // could ever satisfy it on this channel, so it is not re-checked as an independent gate.
    // Conjunct 3 (successor uniqueness) is enforced INSIDE this call, as the current_sessions
    // UNIQUE(host_id, session_id) violation (errata 5(l)/5(m)) — never re-derived here.
    // `row.pane_key` (the row's OWN key, from the suffix-resolved lookup above) is used, not
    // `params.paneKey` — they can legitimately differ (MEDIUM-1) and recordSelfReportRotation's
    // own UPDATE targets its pane argument by EXACT match.
    const rotation = recordSelfReportRotation(db, {
      hostId: params.hostId,
      paneKey: row.pane_key,
      previousSessionId: row.session_id,
      sessionId: params.reportedSessionId,
      launchGeneration: row.launch_generation,
      executionHostId: row.execution_host_id
    })
    if (rotation.ok) {
      return { kind: 'rotated', row: rotation.row }
    }
    // rotation.reason is 'foreign_session_id' (T33: the successor collided with another
    // pane's newest id) or 'no_matching_launch_row' (the row this call itself just read was
    // concurrently retired) — either way this is not a rotation; fall through to the alarm.
  }

  const unrecorded = newestUnrecordedAdmissionThisGeneration(db, params, row)
  if (unrecorded) {
    writeAgentAudit(db, {
      agentId: row.agent_id,
      actorPaneKey: params.paneKey,
      actorHostId: params.hostId,
      verb: 'session_identity_mismatch',
      outcome: 'unrecorded_launch',
      reasonCode: `recorded=${row.session_id} reported=${params.reportedSessionId} admission_reason=${unrecorded}`
    })
    return { kind: 'unrecorded_launch', reason: unrecorded }
  }

  raiseMismatchAlarm(db, row, params)
  return { kind: 'foreign_mismatch' }
}

/** [Ruling 34 Addendum 18(iii)/19, D-R108 R1; Ruling 34 Addendum 20 (c)] (a) selects the pane's
 * newest admission audit of ANY verb in the shared `ADMISSION_AUDIT_VERBS` constant (not just
 * 'launch_unrecorded') and downgrades ONLY when THAT newest one
 * is itself the unrecorded outcome — a later launch_self_resume/launch_refused/launch (contest)
 * audit, or a later plain HOST_MINTED/HOST_RESUME launch (no audit, but a newer `row`), must
 * restore normal classification, not be shadowed by an older unrecorded audit. (b) generation-
 * bound: `row.launch_generation` must equal `params.launchGeneration` — agent_audit carries no
 * generation column to filter the audit query itself, so the launch ROW's own generation is the
 * anchor; a stale prior-generation row (and whatever admission history is attached to it) can
 * never suppress a genuine contest in the CURRENT generation. (c) resolved by pane SUFFIX, same
 * rule as `newestLaunchForPaneSuffix`. */
function newestUnrecordedAdmissionThisGeneration(
  db: Database.Database,
  params: LiveHookReportMismatchParams,
  row: AgentLaunchSessionRow
): string | undefined {
  if (row.launch_generation !== params.launchGeneration) {
    return undefined
  }
  const placeholders = ADMISSION_AUDIT_VERBS.map(() => '?').join(', ')
  const audit = db
    .prepare(
      `SELECT verb, reason_code, at FROM agent_audit
         WHERE substr(actor_pane_key, instr(actor_pane_key, ':') + 1) = ?
           AND verb IN (${placeholders})
         ORDER BY seq DESC LIMIT 1`
    )
    .get(paneSuffix(params.paneKey), ...ADMISSION_AUDIT_VERBS) as
    | { verb: string; reason_code: string | null; at: string }
    | undefined
  if (!audit || audit.verb !== 'launch_unrecorded' || audit.reason_code === null) {
    return undefined
  }
  // Newer-or-equal than the launch row means the admission's LAST word on this pane, this
  // generation, was "nothing recorded, here's why" — a later real launch (a fresher `row`)
  // supersedes an earlier unrecorded audit even though both share the same generation id.
  return audit.at >= row.recorded_at ? audit.reason_code : undefined
}

/** The foreign-id mismatch alarm (T31/T33): one audit row, `verb: 'session_identity_mismatch'`,
 * `outcome: 'contested'`, naming both the recorded and reported ids. [Ruling 34 Addendum 18,
 * correcting Addendum 17's error] UNCONDITIONAL for any NEW fact — the caller (the runtime-layer
 * wiring, C6a item 6) is responsible for its OWN notice clamp via `writeHostNoticeToPane`, keyed
 * per agentId when `row.agent_id` is non-null else per pane, 24h window — that is the ONLY rate
 * clamp; this function never rate-limits by time. [S10-21a C6c, Ruling 34 Addendum 20] What it
 * DOES do is DEDUPE — not clamp: a repeated hook report producing the exact same
 * (recorded, reported) pair as the pane's own newest `session_identity_mismatch`/`contested`
 * audit row writes nothing more (that fact is already on record); ANY new fact — a different
 * reported id, a different recorded id, or the newest audit being some other outcome entirely
 * (e.g. `unrecorded_launch`) — still audits unconditionally, no matter how recently. This is
 * the distinction Addendum 20 draws against Addendum 17's original (and wrong) "clamp by time"
 * framing: identical noise is silenced, new evidence never is. */
function raiseMismatchAlarm(
  db: Database.Database,
  row: AgentLaunchSessionRow,
  params: LiveHookReportMismatchParams
): void {
  const reasonCode = `recorded=${row.session_id} reported=${params.reportedSessionId}`
  const newest = db
    .prepare(
      `SELECT outcome, reason_code FROM agent_audit
         WHERE actor_pane_key = ? AND verb = 'session_identity_mismatch'
         ORDER BY seq DESC LIMIT 1`
    )
    .get(params.paneKey) as { outcome: string; reason_code: string | null } | undefined
  const isDuplicateOfNewest =
    newest !== undefined && newest.outcome === 'contested' && newest.reason_code === reasonCode
  if (!isDuplicateOfNewest) {
    writeAgentAudit(db, {
      agentId: row.agent_id,
      actorPaneKey: params.paneKey,
      actorHostId: params.hostId,
      verb: 'session_identity_mismatch',
      outcome: 'contested',
      reasonCode
    })
  }
  // [§2.6 item 4, D-R107 LOW-1/fix item 7] Structured console.warn so it lands in the service
  // journal on the VPS, same as §2.6's contested-lineage alarm requires for Layer 2 — kept
  // unconditional (Addendum 20 scopes the dedupe to "the audit write" only).
  console.warn('[S10-21a] session_identity_mismatch', {
    hostId: params.hostId,
    paneKey: params.paneKey,
    agentId: row.agent_id,
    recordedSessionId: row.session_id,
    reportedSessionId: params.reportedSessionId,
    deduped: isDuplicateOfNewest
  })
}
