// S10-21a C6/C6a (design v3.2 §2.3, §2.6, §1.6; errata 5(l)/5(m)/5(n); D-R107; Ruling 34
// Addendum 18): Layer 1's own detection surface — a live pane's hook-reported session id
// compared against its own agent_launch_sessions row (never current_sessions, and never a peer
// pane's row: §2.3's continuity rule reads agent_launch_sessions as the sole source of lineage
// truth). This module is pure DB: the caller supplies the already-verified anchor/shape
// conjuncts (1: launch-token anchor, per verifyLivePaneLaunchTokenHash, captured as
// `anchorCorroborated` at hook-ingestion time — server.ts's `recordCurrentAuthorityObservation`;
// 4: the SessionStart `source` value Claude Code itself reported) — this file has no runtime
// handle to derive those itself, matching agent-restore-rebind.ts's own split between pure
// predicate and runtime-supplied evidence (C4a/C5).
//
// §1.6's four conjuncts, as checked here:
//   1. anchorCorroborated        — caller-supplied (isCorroboratedAuthority's captured verdict)
//   2. reportedPreviousSessionId === the pane's own last-recorded session_id — checked here
//   3. successor uniqueness      — enforced by recordSelfReportRotation's current_sessions
//                                   UNIQUE(host_id, session_id) violation, not re-checked here
//   4. sessionStartSource === 'fork' — [D-R107 fix item 8, Addendum 18] narrowed to the ONE
//      measured rotation trigger (errata 5(u)); 'startup'/'resume'/'clear' never satisfy this
//      conjunct even with a matching previous id — a plain restart is not a rotation.
//
// All four hold -> recordSelfReportRotation (T30). Any conjunct fails, INCLUDING a conjunct-3
// collision recordSelfReportRotation itself refuses -> the foreign-id mismatch alarm (T31/T33):
// a `session_identity_mismatch` audit row — UNCONDITIONAL (Addendum 18, correcting Ruling 34
// Addendum 17's C6 error that bundled the audit under the same clamp as the notice). This module
// never touches current_sessions directly; only recordSelfReportRotation's own upsert does, on
// the accepted rotation path.
import type Database from '../../sqlite/sync-database'
import {
  newestLaunchForPaneSuffix,
  recordSelfReportRotation,
  type AgentLaunchSessionRow
} from './agent-launch-sessions'
import { writeAgentAudit } from './agent-audit-log'

export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'fork'

export type LiveHookReportMismatchParams = {
  hostId: string
  paneKey: string
  /** The session id the pane's own live hook report carries right now. */
  reportedSessionId: string
  /** The report's own claimed predecessor id, when the report carries one (§1.6 conjunct 2).
   * [D-R107 BLOCKER-2/fix item 3] Claude Code's `fork` SessionStart carries no field naming its
   * parent session — always undefined from that one channel that could populate conjunct 4's
   * source. Left as an explicit parameter (rather than removed) for a future measured carrier;
   * callers today pass the pane's own recorded id directly when `sessionStartSource === 'fork'`
   * (the fallback Addendum 18/errata 5(aa) names), never invented from `undefined`. */
  reportedPreviousSessionId: string | null
  /** Conjunct 1: `isCorroboratedAuthority`'s ACTUAL, captured verdict for this hook report
   * (server.ts's `anchorCorroborated`, stamped at ingestion — never re-derived later). */
  anchorCorroborated: boolean
  /** Conjunct 4 [D-R107 fix item 8]: the explicit SessionStart `source` value this generation
   * observed for this pane, when any — undefined when no SessionStart was observed at all. */
  sessionStartSource: SessionStartSource | undefined
}

export type LiveHookReportMismatchResult =
  | { kind: 'match' }
  | { kind: 'no_row' }
  | { kind: 'rotated'; row: AgentLaunchSessionRow }
  | { kind: 'foreign_mismatch' }
  // [Ruling 34 Addendum 18(iii)] Honest floors do not false-alarm: the admission's own newest
  // outcome for this pane, this generation, was UNRECORDED(reason) — the disagreement is fully
  // explained by "nothing was ever recorded to agree with", not a contest.
  | { kind: 'unrecorded_launch'; reason: string }

/** §2.3/§2.6/§1.6, Layer 1. Compares a live pane's hook-reported session id against its own
 * newest `agent_launch_sessions` row (resolved by pane SUFFIX, D-R107 MEDIUM-1 — identity is by
 * suffix everywhere else in this design). A disagreement satisfying all four §1.6 conjuncts is a
 * legitimate self-report rotation (T30, no alarm); a disagreement on a pane whose newest
 * admission outcome this generation was UNRECORDED is `unrecorded_launch` (Addendum 18(iii));
 * any other disagreement is a foreign-id mismatch (T31/T33) — audited UNCONDITIONALLY
 * (Addendum 18), row unchanged. */
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
  const conjunct2 = params.reportedPreviousSessionId === row.session_id
  const conjunct4 = params.sessionStartSource === 'fork'

  if (conjunct1 && conjunct2 && conjunct4) {
    // Conjunct 3 (successor uniqueness) is enforced INSIDE this call, as the
    // current_sessions UNIQUE(host_id, session_id) violation (errata 5(l)/5(m)) — never
    // re-derived here. `row.pane_key` (the row's OWN key, from the suffix-resolved lookup
    // above) is used, not `params.paneKey` — they can legitimately differ (MEDIUM-1) and
    // recordSelfReportRotation's own UPDATE targets its pane argument by EXACT match.
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

  const unrecorded = newestUnrecordedLaunchThisGeneration(db, params.paneKey, row)
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

// [Ruling 34 Addendum 18(iii)] The pane's newest 'launch_unrecorded' audit row
// (agent-launch-admission.ts's `unrecorded()` helper writes verb 'launch_unrecorded', outcome
// 'admitted', reasonCode = the UNRECORDED reason) — compared by timestamp against the launch
// row's own `recorded_at` (both 1-second-resolution `datetime('now')` TEXT, directly
// comparable). Newer-or-equal means the admission's LAST word on this pane was "nothing
// recorded, here's why" — the disagreement this call is about is explained, not contested.
function newestUnrecordedLaunchThisGeneration(
  db: Database.Database,
  paneKey: string,
  row: AgentLaunchSessionRow
): string | undefined {
  const audit = db
    .prepare(
      `SELECT reason_code, at FROM agent_audit
         WHERE actor_pane_key = ? AND verb = 'launch_unrecorded'
         ORDER BY seq DESC LIMIT 1`
    )
    .get(paneKey) as { reason_code: string | null; at: string } | undefined
  if (!audit || audit.reason_code === null) {
    return undefined
  }
  return audit.at >= row.recorded_at ? audit.reason_code : undefined
}

/** The foreign-id mismatch alarm (T31/T33): one audit row, `verb: 'session_identity_mismatch'`,
 * `outcome: 'contested'`, naming both the recorded and reported ids. [Ruling 34 Addendum 18,
 * correcting Addendum 17's error] UNCONDITIONAL — the caller (the runtime-layer wiring, C6a
 * item 6) is responsible for its OWN notice clamp via `writeHostNoticeToPane`, keyed per
 * agentId when `row.agent_id` is non-null else per pane, 24h window — that is the ONLY clamp;
 * this function never rate-limits the audit itself. */
function raiseMismatchAlarm(
  db: Database.Database,
  row: AgentLaunchSessionRow,
  params: LiveHookReportMismatchParams
): void {
  writeAgentAudit(db, {
    agentId: row.agent_id,
    actorPaneKey: params.paneKey,
    actorHostId: params.hostId,
    verb: 'session_identity_mismatch',
    outcome: 'contested',
    reasonCode: `recorded=${row.session_id} reported=${params.reportedSessionId}`
  })
  // [§2.6 item 4, D-R107 LOW-1/fix item 7] Structured console.warn so it lands in the service
  // journal on the VPS, same as §2.6's contested-lineage alarm requires for Layer 2.
  console.warn('[S10-21a] session_identity_mismatch', {
    hostId: params.hostId,
    paneKey: params.paneKey,
    agentId: row.agent_id,
    recordedSessionId: row.session_id,
    reportedSessionId: params.reportedSessionId
  })
}
