// S10-21a C6 (design v3.2 §2.3, §2.6, §1.6; errata 5(l)/5(m)/5(n)): Layer 1's own detection
// surface — a live pane's hook-reported session id compared against its own
// agent_launch_sessions row (never current_sessions, and never a peer pane's row: §2.3's
// continuity rule reads agent_launch_sessions as the sole source of lineage truth). This module
// is pure DB: the caller supplies the already-verified anchor/shape conjuncts (1: launch-token
// anchor, per verifyLivePaneLaunchTokenHash; 4: this generation's own SessionStart observed) —
// this file has no runtime handle to derive those itself, matching agent-restore-rebind.ts's own
// split between pure predicate and runtime-supplied evidence (C4a/C5).
//
// §1.6's four conjuncts, as checked here:
//   1. anchorVerified            — caller-supplied (verifyLivePaneLaunchTokenHash)
//   2. reportedPreviousSessionId === the pane's own last-recorded session_id — checked here
//   3. successor uniqueness      — enforced by recordSelfReportRotation's current_sessions
//                                   UNIQUE(host_id, session_id) violation, not re-checked here
//   4. sessionStartObservedThisGeneration — caller-supplied (D-I35 item 5)
//
// All four hold -> recordSelfReportRotation (T30). Any conjunct fails, INCLUDING a conjunct-3
// collision recordSelfReportRotation itself refuses -> the foreign-id mismatch alarm (T31/T33):
// a `session_identity_mismatch` audit row, rate-limited to one per pane per hour (the brief's
// explicit SCOPE/TESTS text — see the RETURN block for the discrepancy this resolves against
// §2.6's literal "the audit row is always written" wording). This module never touches
// current_sessions directly; only recordSelfReportRotation's own upsert does, on the accepted
// rotation path.
import type Database from '../../sqlite/sync-database'
import {
  newestLaunchForPane,
  recordSelfReportRotation,
  type AgentLaunchSessionRow
} from './agent-launch-sessions'
import { writeAgentAudit } from './agent-audit-log'
import { checkAndBumpRate } from './agent-rate-limit'

/** [SCOPE] "one audit + notice per pane per hour" — matches
 * LAUNCH_ADMISSION_NOTICE_WINDOW_MS (orca-runtime.ts:2024), kept as its own named constant here
 * since this module has no dependency on orca-runtime.ts. */
export const SESSION_IDENTITY_MISMATCH_WINDOW_MS = 60 * 60 * 1000

export type LiveHookReportMismatchParams = {
  hostId: string
  paneKey: string
  /** The session id the pane's own live hook report carries right now. */
  reportedSessionId: string
  /** The report's own claimed predecessor id, when the report carries one (§1.6 conjunct 2). */
  reportedPreviousSessionId: string | null
  /** Conjunct 1: `verifyLivePaneLaunchTokenHash` succeeded with the reported paneKey equal to
   * the anchor's own pane (persistence.ts:7025-7046 mints the anchor at launch, §2.2). */
  anchorVerified: boolean
  /** Conjunct 4: this pane's own SessionStart, `source` in {fork, startup}, was observed in
   * this runtime generation (D-I35 item 5) — a shape/timing limiter, not corroboration. */
  sessionStartObservedThisGeneration: boolean
}

export type LiveHookReportMismatchResult =
  | { kind: 'match' }
  | { kind: 'no_row' }
  | { kind: 'rotated'; row: AgentLaunchSessionRow }
  | { kind: 'foreign_mismatch'; auditWritten: boolean }

/** §2.3/§2.6/§1.6, Layer 1. Compares a live pane's hook-reported session id against its own
 * newest `agent_launch_sessions` row. A disagreement satisfying all four §1.6 conjuncts is a
 * legitimate self-report rotation (T30, no alarm); any other disagreement is a foreign-id
 * mismatch (T31/T33) — audited, rate-limited to one per pane per hour, row unchanged. */
export function evaluateLiveHookReportMismatch(
  db: Database.Database,
  params: LiveHookReportMismatchParams
): LiveHookReportMismatchResult {
  const row = newestLaunchForPane(db, params.hostId, params.paneKey)
  if (!row) {
    return { kind: 'no_row' }
  }
  if (row.session_id === params.reportedSessionId) {
    return { kind: 'match' }
  }

  const conjunct1 = params.anchorVerified
  const conjunct2 = params.reportedPreviousSessionId === row.session_id
  const conjunct4 = params.sessionStartObservedThisGeneration

  if (conjunct1 && conjunct2 && conjunct4) {
    // Conjunct 3 (successor uniqueness) is enforced INSIDE this call, as the
    // current_sessions UNIQUE(host_id, session_id) violation (errata 5(l)/5(m)) — never
    // re-derived here.
    const rotation = recordSelfReportRotation(db, {
      hostId: params.hostId,
      paneKey: params.paneKey,
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

  return { kind: 'foreign_mismatch', auditWritten: raiseMismatchAlarm(db, row, params) }
}

/** The foreign-id mismatch alarm (T31/T33): one audit row, `verb: 'session_identity_mismatch'`,
 * `outcome: 'contested'`, naming both the recorded and reported ids — clamped to one per pane
 * per hour by the SAME checkAndBumpRate pattern C5's predicate uses for its own rate clause.
 * Returns whether the audit was actually written (false when clamped) so the caller can gate
 * its own pane-notice call the same way, without a second, independently-keyed rate check
 * double-consuming this window (see the RETURN block). */
function raiseMismatchAlarm(
  db: Database.Database,
  row: AgentLaunchSessionRow,
  params: LiveHookReportMismatchParams
): boolean {
  const rate = checkAndBumpRate(db, {
    subjectKey: params.paneKey,
    verb: 'session_identity_mismatch',
    windowMs: SESSION_IDENTITY_MISMATCH_WINDOW_MS,
    limit: 1
  })
  if (!rate.allowed) {
    return false
  }
  writeAgentAudit(db, {
    agentId: row.agent_id,
    actorPaneKey: params.paneKey,
    actorHostId: params.hostId,
    verb: 'session_identity_mismatch',
    outcome: 'contested',
    reasonCode: `recorded=${row.session_id} reported=${params.reportedSessionId}`
  })
  return true
}
