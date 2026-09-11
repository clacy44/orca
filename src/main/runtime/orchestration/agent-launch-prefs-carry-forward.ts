// [S10-21d Gate-3 fix] Split out (max-lines budget on both callers, per _common-rules.md "split
// modules if needed and say so"): prefs to carry into a NEW `agent_launch_sessions` row for the
// SAME session/agent (a daemon-survived handle refresh, a sweep restore moving pane keys) —
// never a genuinely new session. Never invents a source; a row with no stored prefs yields
// `undefined` (NULL columns), matching design (d)'s existing no-prefs write.
import type Database from '../../sqlite/sync-database'
import {
  newestLaunchForPane,
  recordLaunchInTransaction,
  type AgentLaunchSessionRow,
  type RecordLaunchParams,
  type RecordLaunchResult
} from './agent-launch-sessions'

export function carryForwardPrefs(
  row: AgentLaunchSessionRow | undefined
): RecordLaunchParams['prefs'] {
  return row?.pref_source != null
    ? {
        model: row.pref_model ?? undefined,
        effort: row.pref_effort ?? undefined,
        source: row.pref_source
      }
    : undefined
}

/** [S10-21d Gate-3 fix] `agent-restore-rebind.ts`'s own "admission didn't already write this
 * restore's row" branch, split out here (max-lines) — same `recordLaunchInTransaction` call it
 * always made, now carrying the predecessor pane's prefs forward via `carryForwardPrefs` instead
 * of silently dropping them. */
export function recordSweepRecordLaunch(
  db: Database.Database,
  params: {
    hostId: string
    newPaneKey: string
    sessionId: string
    launchGeneration: string
    executionHostId: string
    predecessorPaneKey: string | undefined
  }
): RecordLaunchResult {
  const predecessorRow = params.predecessorPaneKey
    ? newestLaunchForPane(db, params.hostId, params.predecessorPaneKey)
    : undefined
  return recordLaunchInTransaction(db, {
    hostId: params.hostId,
    paneKey: params.newPaneKey,
    agentType: 'claude',
    sessionId: params.sessionId,
    launchGeneration: params.launchGeneration,
    executionHostId: params.executionHostId,
    evidence: 'sweep_record',
    supersedePaneKey: params.predecessorPaneKey,
    prefs: carryForwardPrefs(predecessorRow)
  })
}
