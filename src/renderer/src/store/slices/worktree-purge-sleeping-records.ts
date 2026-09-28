// Artifact 10z.5 R288 (T15): a worktree purge also drops the saved sleeping-agent records that name
// the purged worktree themselves, with their panes' launch configs. The tab-prefix omit in
// `buildWorktreePurgeState` misses a record whose tab was already closed (an orphaned record).
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'

export function dropSleepingRecordsOfPurgedWorktrees<C>(
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>,
  agentLaunchConfigByPaneKey: Record<string, C>,
  worktreeIdSet: ReadonlySet<string>
): {
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
  agentLaunchConfigByPaneKey: Record<string, C>
} {
  if (!sleepingAgentSessionsByPaneKey) {
    return { sleepingAgentSessionsByPaneKey, agentLaunchConfigByPaneKey }
  }
  // Records carry either the raw worktree id or its workspace-key form.
  const purged = new Set<string>()
  for (const id of worktreeIdSet) {
    purged.add(id)
    purged.add(isWorkspaceKey(id) ? id : worktreeWorkspaceKey(id))
  }
  const doomedPaneKeys = Object.entries(sleepingAgentSessionsByPaneKey)
    .filter(([, record]) => purged.has(record.worktreeId))
    .map(([paneKey]) => paneKey)
  if (doomedPaneKeys.length === 0) {
    return { sleepingAgentSessionsByPaneKey, agentLaunchConfigByPaneKey }
  }
  const omit = <T>(obj: Record<string, T>): Record<string, T> => {
    if (!obj) {
      return obj
    }
    const out = { ...obj }
    for (const paneKey of doomedPaneKeys) {
      delete out[paneKey]
    }
    return out
  }
  return {
    sleepingAgentSessionsByPaneKey: omit(sleepingAgentSessionsByPaneKey),
    agentLaunchConfigByPaneKey: omit(agentLaunchConfigByPaneKey)
  }
}
