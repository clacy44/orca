import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

/**
 * A slept pane bound to a person's Claude credential lane (S9 §2a/§2h).
 *
 * The renderer wake does not reuse the slept pane — it mints a fresh, unbound one, which resolves
 * to the shared `~/.claude`. So a lane-bound record is never handed to it: it stays asleep, and
 * resumes only through the host create path.
 */
export function isLaneBoundSleepingRecord(record: { lanePrincipalId?: string }): boolean {
  return typeof record.lanePrincipalId === 'string' && record.lanePrincipalId.length > 0
}

/**
 * Carry the host's pane→lane rows onto the records restored beside them.
 *
 * The rows are host-owned and pane-keyed; the record is what the wake reads, and it is the only
 * carrier that survives into a renderer that never sees the row map.
 */
export function stampSleepingAgentSessionLanes(
  records: Record<string, SleepingAgentSessionRecord>,
  lanesByPaneKey: WorkspaceSessionState['terminalCredentialLanesByPaneKey']
): Record<string, SleepingAgentSessionRecord> {
  if (!lanesByPaneKey) {
    return records
  }
  let changed = false
  const stamped: Record<string, SleepingAgentSessionRecord> = {}
  for (const [paneKey, record] of Object.entries(records)) {
    const principalId = lanesByPaneKey[paneKey]?.principalId
    if (principalId && record.lanePrincipalId !== principalId) {
      stamped[paneKey] = { ...record, lanePrincipalId: principalId }
      changed = true
      continue
    }
    stamped[paneKey] = record
  }
  return changed ? stamped : records
}
