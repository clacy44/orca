import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

/**
 * A tabless, worktree-attributed status entry is a live agent only while it is
 * fresh, or while its orchestration parent is a currently open tab (the worker
 * spawned before its own tab appeared). Otherwise it is retained history — a
 * ghost row from a pane whose tab and PTY are both gone (#6072-adjacent).
 */
export function isTablessEntryLiveForWorktreeRow(
  isFresh: boolean,
  entry: AgentStatusEntry,
  currentTabIds: Set<string>
): boolean {
  if (isFresh) {
    return true
  }
  const parentPaneKey = entry.orchestration?.parentPaneKey
  const parentTabId = parentPaneKey ? parsePaneKey(parentPaneKey)?.tabId : undefined
  return parentTabId !== undefined && currentTabIds.has(parentTabId)
}
