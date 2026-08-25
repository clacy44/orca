import type { Tab, TabGroup, TabGroupLayoutNode, WorkspaceVisibleTabType } from './tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'

export type WorkspaceSessionTerminalTabCloseResult = {
  session: WorkspaceSessionState
  ptyIdsToKill: string[]
  closed: boolean
  pinned: boolean
}

function pickNextActiveTab(group: TabGroup, closingIds: ReadonlySet<string>): string | null {
  const remaining = group.tabOrder.filter((id) => !closingIds.has(id))
  for (let index = (group.recentTabIds?.length ?? 0) - 1; index >= 0; index -= 1) {
    const id = group.recentTabIds![index]
    if (remaining.includes(id)) {
      return id
    }
  }
  const closingIndex = group.tabOrder.findIndex((id) => closingIds.has(id))
  return (
    remaining.find((id) => group.tabOrder.indexOf(id) > closingIndex) ?? remaining.at(-1) ?? null
  )
}

function pruneGroupLayout(
  node: TabGroupLayoutNode | undefined,
  validGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | undefined {
  if (!node) {
    return undefined
  }
  if (node.type === 'leaf') {
    return validGroupIds.has(node.groupId) ? node : undefined
  }
  const first = pruneGroupLayout(node.first, validGroupIds)
  const second = pruneGroupLayout(node.second, validGroupIds)
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return { ...node, first, second }
}

function collectTabPtyIds(
  session: WorkspaceSessionState,
  tabId: string,
  rowPtyId?: string | null
): Set<string> {
  const ids = new Set<string>()
  if (rowPtyId) {
    ids.add(rowPtyId)
  }
  for (const ptyId of Object.values(session.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {})) {
    ids.add(ptyId)
  }
  const remoteSessionId = session.remoteSessionIdsByTabId?.[tabId]
  if (remoteSessionId) {
    ids.add(remoteSessionId)
  }
  return ids
}

function findUnifiedTerminalTabs(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string
): Tab[] {
  return (session.unifiedTabs?.[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'terminal' && (tab.entityId === tabId || tab.id === tabId)
  )
}

function deriveActiveSurface(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabs: Tab[],
  groups: TabGroup[],
  activeGroupId: string | undefined
): {
  terminalTabId: string | null
  browserTabId: string | null
  fileId: string | null
  type: WorkspaceVisibleTabType
} {
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null
  const activeUnified = activeGroup?.activeTabId
    ? (tabs.find((tab) => tab.id === activeGroup.activeTabId && tab.groupId === activeGroup.id) ??
      null)
    : null
  const terminalTabs = session.tabsByWorktree[worktreeId] ?? []
  const browsers = session.browserTabsByWorktree?.[worktreeId] ?? []
  const files = session.openFilesByWorktree?.[worktreeId] ?? []
  const priorTerminal = session.activeTabIdByWorktree?.[worktreeId]
  const terminalFallback = terminalTabs.some((tab) => tab.id === priorTerminal)
    ? (priorTerminal ?? null)
    : (terminalTabs[0]?.id ?? null)
  const priorBrowser = session.activeBrowserTabIdByWorktree?.[worktreeId]
  const browserFallback = browsers.some((tab) => tab.id === priorBrowser)
    ? (priorBrowser ?? null)
    : (browsers[0]?.id ?? null)
  const priorFile = session.activeFileIdByWorktree?.[worktreeId]
  const fileFallback = files.some((file) => file.filePath === priorFile)
    ? (priorFile ?? null)
    : (files[0]?.filePath ?? null)

  if (activeUnified?.contentType === 'terminal') {
    return {
      terminalTabId: activeUnified.entityId,
      browserTabId: browserFallback,
      fileId: fileFallback,
      type: 'terminal'
    }
  }
  if (activeUnified?.contentType === 'browser') {
    return {
      terminalTabId: terminalFallback,
      browserTabId: activeUnified.entityId,
      fileId: fileFallback,
      type: 'browser'
    }
  }
  if (activeUnified) {
    return {
      terminalTabId: terminalFallback,
      browserTabId: browserFallback,
      fileId: activeUnified.entityId,
      type: activeUnified.contentType === 'simulator' ? 'simulator' : 'editor'
    }
  }
  if (fileFallback) {
    return {
      terminalTabId: terminalFallback,
      browserTabId: browserFallback,
      fileId: fileFallback,
      type: 'editor'
    }
  }
  if (browserFallback) {
    return {
      terminalTabId: terminalFallback,
      browserTabId: browserFallback,
      fileId: null,
      type: 'browser'
    }
  }
  return { terminalTabId: terminalFallback, browserTabId: null, fileId: null, type: 'terminal' }
}

export function closeTerminalTabInWorkspaceSession(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string
): WorkspaceSessionTerminalTabCloseResult {
  const terminalRow = session.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
  const unifiedTerminalTabs = findUnifiedTerminalTabs(session, worktreeId, tabId)
  if (!terminalRow && unifiedTerminalTabs.length === 0) {
    return { session, ptyIdsToKill: [], closed: false, pinned: false }
  }
  if (terminalRow?.isPinned || unifiedTerminalTabs.some((tab) => tab.isPinned)) {
    return { session, ptyIdsToKill: [], closed: false, pinned: true }
  }

  const closingPtyIds = collectTabPtyIds(session, tabId, terminalRow?.ptyId)

  // Why: RC2 can leave duplicate rows bound to the same ptyId (a reattach that
  // minted a fresh tab instead of rebinding). Collapse those duplicates into
  // this close so the PTY's last *real* referrer is this operation and not a
  // leftover row — otherwise close-all never converges (#RC3/B4).
  const duplicateTabIds = new Set<string>()
  if (closingPtyIds.size > 0) {
    for (const tab of session.tabsByWorktree[worktreeId] ?? []) {
      if (tab.id === tabId || !tab.ptyId || !closingPtyIds.has(tab.ptyId)) {
        continue
      }
      // Why not "no layout of its own": persistPtyBinding always mints a
      // minimal layout alongside a row, so an RC2 leftover has one too — that
      // can't distinguish it from a deliberate shared-pty tab. What can: a
      // duplicate references no *other* live session — every ptyId it owns
      // is already among the ones this close is killing. A tab that also
      // owns a distinct pty (e.g. a second real pane) is not swept.
      const isSubsetOfClosing = [...collectTabPtyIds(session, tab.id, tab.ptyId)].every((ptyId) =>
        closingPtyIds.has(ptyId)
      )
      if (isSubsetOfClosing) {
        duplicateTabIds.add(tab.id)
      }
    }
  }

  const otherPtyIds = new Set<string>()
  for (const tabs of Object.values(session.tabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.id !== tabId && !duplicateTabIds.has(tab.id)) {
        for (const ptyId of collectTabPtyIds(session, tab.id, tab.ptyId)) {
          otherPtyIds.add(ptyId)
        }
      }
    }
  }
  const ptyIdsToKill = [...closingPtyIds].filter((ptyId) => !otherPtyIds.has(ptyId))
  const closedVisibleIds = new Set(unifiedTerminalTabs.map((tab) => tab.id))
  closedVisibleIds.add(tabId)
  for (const duplicateTabId of duplicateTabIds) {
    closedVisibleIds.add(duplicateTabId)
    for (const duplicateUnified of findUnifiedTerminalTabs(session, worktreeId, duplicateTabId)) {
      closedVisibleIds.add(duplicateUnified.id)
    }
  }
  const nextTabs = (session.unifiedTabs?.[worktreeId] ?? []).filter(
    (tab) => !closedVisibleIds.has(tab.id)
  )
  const nextGroups = (session.tabGroups?.[worktreeId] ?? [])
    .map((group) => {
      const tabOrder = group.tabOrder.filter((id) => !closedVisibleIds.has(id))
      const activeTabId = closedVisibleIds.has(group.activeTabId ?? '')
        ? pickNextActiveTab(group, closedVisibleIds)
        : group.activeTabId && tabOrder.includes(group.activeTabId)
          ? group.activeTabId
          : (tabOrder[0] ?? null)
      return {
        ...group,
        tabOrder,
        activeTabId,
        recentTabIds: group.recentTabIds?.filter((id) => tabOrder.includes(id))
      }
    })
    .filter((group) => group.tabOrder.length > 0)
  const validGroupIds = new Set(nextGroups.map((group) => group.id))
  const priorActiveGroupId = session.activeGroupIdByWorktree?.[worktreeId]
  const nextActiveGroupId = validGroupIds.has(priorActiveGroupId ?? '')
    ? priorActiveGroupId
    : nextGroups[0]?.id
  const nextLayout = pruneGroupLayout(session.tabGroupLayouts?.[worktreeId], validGroupIds)

  const next: WorkspaceSessionState = {
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [worktreeId]: (session.tabsByWorktree[worktreeId] ?? []).filter(
        (tab) => tab.id !== tabId && !duplicateTabIds.has(tab.id)
      )
    },
    terminalLayoutsByTabId: { ...session.terminalLayoutsByTabId },
    unifiedTabs: { ...session.unifiedTabs, [worktreeId]: nextTabs },
    tabGroups: { ...session.tabGroups, [worktreeId]: nextGroups },
    tabGroupLayouts: { ...session.tabGroupLayouts },
    activeGroupIdByWorktree: { ...session.activeGroupIdByWorktree },
    remoteSessionIdsByTabId: { ...session.remoteSessionIdsByTabId },
    sleepingAgentSessionsByPaneKey: { ...session.sleepingAgentSessionsByPaneKey }
  }
  delete next.terminalLayoutsByTabId[tabId]
  delete next.remoteSessionIdsByTabId![tabId]
  for (const duplicateTabId of duplicateTabIds) {
    delete next.terminalLayoutsByTabId[duplicateTabId]
    delete next.remoteSessionIdsByTabId![duplicateTabId]
  }
  if (nextLayout) {
    next.tabGroupLayouts![worktreeId] = nextLayout
  } else {
    delete next.tabGroupLayouts![worktreeId]
  }
  if (nextActiveGroupId) {
    next.activeGroupIdByWorktree![worktreeId] = nextActiveGroupId
  } else {
    delete next.activeGroupIdByWorktree![worktreeId]
  }
  for (const [paneKey, record] of Object.entries(next.sleepingAgentSessionsByPaneKey ?? {})) {
    if (
      paneKey.startsWith(`${tabId}:`) ||
      record.tabId === tabId ||
      (record.tabId !== undefined && duplicateTabIds.has(record.tabId)) ||
      [...duplicateTabIds].some((duplicateTabId) => paneKey.startsWith(`${duplicateTabId}:`))
    ) {
      delete next.sleepingAgentSessionsByPaneKey![paneKey]
    }
  }
  const surface = deriveActiveSurface(next, worktreeId, nextTabs, nextGroups, nextActiveGroupId)
  next.activeTabIdByWorktree = {
    ...session.activeTabIdByWorktree,
    [worktreeId]: surface.terminalTabId
  }
  next.activeBrowserTabIdByWorktree = {
    ...session.activeBrowserTabIdByWorktree,
    [worktreeId]: surface.browserTabId
  }
  next.activeFileIdByWorktree = {
    ...session.activeFileIdByWorktree,
    [worktreeId]: surface.fileId
  }
  next.activeTabTypeByWorktree = {
    ...session.activeTabTypeByWorktree,
    [worktreeId]: surface.type
  }
  if (session.activeWorktreeId === worktreeId) {
    next.activeTabId = surface.terminalTabId
    const hasSurface =
      nextTabs.length > 0 ||
      (next.tabsByWorktree[worktreeId]?.length ?? 0) > 0 ||
      (next.browserTabsByWorktree?.[worktreeId]?.length ?? 0) > 0 ||
      (next.openFilesByWorktree?.[worktreeId]?.length ?? 0) > 0
    if (!hasSurface) {
      next.activeWorktreeId = null
      next.activeWorkspaceKey = null
      next.activeWorkspaceExecutionHostId = null
    }
  }
  if ((next.tabsByWorktree[worktreeId]?.length ?? 0) === 0) {
    next.activeWorktreeIdsOnShutdown = next.activeWorktreeIdsOnShutdown?.filter(
      (id) => id !== worktreeId
    )
  }
  return { session: next, ptyIdsToKill, closed: true, pinned: false }
}
