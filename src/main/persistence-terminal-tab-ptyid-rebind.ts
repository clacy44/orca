import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'

// Why a dedicated module: persistence.ts is max-lines ratcheted (delegating
// calls only) — see AGENTS.md.
//
// persistPtyBinding finds a duplicate ptyId already owning a tab row under a
// different (stale) id than the one the caller just asked to bind. Renaming
// that row's `id` in place strands every OTHER structure still keyed by the
// old id (active selection, the unified-tab-bar mirror, the leaf layout —
// including any sibling pane of a split — and per-pane incarnation/lane/
// tombstone state), so this migrates all of them onto the new id instead.
export function migrateTerminalTabId(
  session: WorkspaceSessionState,
  oldTabId: string,
  newTabId: string
): void {
  if (oldTabId === newTabId) {
    return
  }
  if (session.activeTabId === oldTabId) {
    session.activeTabId = newTabId
  }
  if (session.activeTabIdByWorktree) {
    const next: Record<string, string | null> = { ...session.activeTabIdByWorktree }
    let changed = false
    for (const [worktreeId, tabId] of Object.entries(next)) {
      if (tabId === oldTabId) {
        next[worktreeId] = newTabId
        changed = true
      }
    }
    if (changed) {
      session.activeTabIdByWorktree = next
    }
  }
  if (session.unifiedTabs) {
    const next: Record<string, (typeof session.unifiedTabs)[string]> = { ...session.unifiedTabs }
    let changed = false
    for (const [worktreeId, tabs] of Object.entries(next)) {
      let tabsChanged = false
      const nextTabs = tabs.map((tab) => {
        if (tab.id !== oldTabId && tab.entityId !== oldTabId) {
          return tab
        }
        tabsChanged = true
        return {
          ...tab,
          id: tab.id === oldTabId ? newTabId : tab.id,
          entityId:
            tab.contentType === 'terminal' && tab.entityId === oldTabId ? newTabId : tab.entityId
        }
      })
      if (tabsChanged) {
        next[worktreeId] = nextTabs
        changed = true
      }
    }
    if (changed) {
      session.unifiedTabs = next
    }
  }
  if (session.terminalLayoutsByTabId && oldTabId in session.terminalLayoutsByTabId) {
    const { [oldTabId]: movedLayout, ...rest } = session.terminalLayoutsByTabId
    session.terminalLayoutsByTabId = { ...rest, [newTabId]: movedLayout }
  }
  if (session.remoteSessionIdsByTabId && oldTabId in session.remoteSessionIdsByTabId) {
    const { [oldTabId]: movedRelaySessionId, ...rest } = session.remoteSessionIdsByTabId
    session.remoteSessionIdsByTabId = { ...rest, [newTabId]: movedRelaySessionId }
  }
  session.terminalPtyIncarnationsByPaneKey = rekeyPaneKeyPrefix(
    session.terminalPtyIncarnationsByPaneKey,
    oldTabId,
    newTabId
  )
  session.terminalCredentialLanesByPaneKey = rekeyPaneKeyPrefix(
    session.terminalCredentialLanesByPaneKey,
    oldTabId,
    newTabId
  )
  session.terminalSurfaceTombstonesByPaneKey = rekeyPaneKeyPrefix(
    session.terminalSurfaceTombstonesByPaneKey,
    oldTabId,
    newTabId,
    (tombstone) =>
      tombstone.parentTabId === oldTabId ? { ...tombstone, parentTabId: newTabId } : tombstone
  )
  // Why: same paneKey-prefix convention as the other *ByPaneKey maps above,
  // but the record ALSO carries its own paneKey/tabId fields (redundant with
  // the map key) that a key-only rekey would leave stale.
  session.sleepingAgentSessionsByPaneKey = rekeyPaneKeyPrefix(
    session.sleepingAgentSessionsByPaneKey,
    oldTabId,
    newTabId,
    (record) => ({
      ...record,
      paneKey: record.paneKey.startsWith(`${oldTabId}:`)
        ? `${newTabId}:${record.paneKey.slice(`${oldTabId}:`.length)}`
        : record.paneKey,
      ...(record.tabId === oldTabId ? { tabId: newTabId } : {})
    })
  )
}

// paneKey is `${tabId}:${leafId}` — move every entry whose tabId prefix matches.
// `mapValue` additionally rewrites a value that embeds the old tab id itself
// (e.g. a tombstone's parentTabId), so the key rename does not leave stale
// data behind inside the moved record.
function rekeyPaneKeyPrefix<T>(
  record: Record<string, T> | undefined,
  oldTabId: string,
  newTabId: string,
  mapValue?: (value: T) => T
): Record<string, T> | undefined {
  if (!record) {
    return record
  }
  const prefix = `${oldTabId}:`
  let changed = false
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith(prefix)) {
      next[`${newTabId}:${key.slice(prefix.length)}`] = mapValue ? mapValue(value) : value
      changed = true
    } else {
      next[key] = value
    }
  }
  return changed ? next : record
}
