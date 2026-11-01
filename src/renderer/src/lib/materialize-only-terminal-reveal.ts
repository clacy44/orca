import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import type { AppState } from '@/store/types'
import {
  MATERIALIZE_ONLY_ERROR_AMBIGUOUS,
  MATERIALIZE_ONLY_ERROR_TAB_CONFLICT,
  MATERIALIZE_ONLY_ERROR_UNKNOWN_WORKTREE,
  type TerminalRevealIdentity
} from '../../../shared/terminal-reveal-identity'
import { resolveTerminalTabPtyOwnership } from './terminal-tab-for-pty-id'

type MaterializeOnlyState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'pendingReconnectPtyIdByTabId'
  | 'getKnownWorktreeById'
>

export type MaterializeOnlyPlan =
  | { kind: 'owned'; tabId: string; identity?: TerminalRevealIdentity }
  | { kind: 'error'; error: string }
  | { kind: 'add-leaf'; tabId: string; sourceLeafId: string }
  /** The tab already holds the requested leaf, unbound: bind it to this pty. */
  | { kind: 'bind-leaf'; tabId: string }
  /** The tab exists with no layout: fill it with the requested leaf. */
  | { kind: 'fill-empty'; tabId: string }
  | { kind: 'fresh' }

// Why: main re-shows a terminal this window lost its tab for; it must never duplicate one a tab
// already records, rewrite a layout, or mint a second tab under a tab id another worktree owns.
export function planMaterializeOnlyTerminalReveal(
  state: MaterializeOnlyState,
  request: {
    worktreeId: string
    ptyId: string
    tabId: string
    leafId: string
    splitFromLeafId?: string
  }
): MaterializeOnlyPlan {
  const { worktreeId, ptyId, tabId, leafId } = request
  const resolved = resolveTerminalTabPtyOwnership(state, worktreeId, ptyId)
  // Why: hydration nulls `tab.ptyId` and the reconcile runs before reconnect, so the pending map is
  // the only record that a restored tab still owns this pty.
  const pendingOwners = (state.tabsByWorktree[worktreeId] ?? []).filter(
    (tab) => state.pendingReconnectPtyIdByTabId[tab.id] === ptyId
  )
  const ownership =
    resolved.kind !== 'none' || pendingOwners.length === 0
      ? resolved
      : pendingOwners.length === 1
        ? ({ kind: 'owned', tabId: pendingOwners[0]!.id } as const)
        : ({ kind: 'ambiguous' } as const)
  if (ownership.kind === 'owned') {
    const ptyIdsByLeafId = state.terminalLayoutsByTabId[ownership.tabId]?.ptyIdsByLeafId ?? {}
    const boundLeafId =
      ptyIdsByLeafId[leafId] === ptyId
        ? leafId
        : Object.keys(ptyIdsByLeafId).find((candidate) => ptyIdsByLeafId[candidate] === ptyId)
    return {
      kind: 'owned',
      tabId: ownership.tabId,
      ...(boundLeafId
        ? { identity: { worktreeId, tabId: ownership.tabId, leafId: boundLeafId, ptyId } }
        : {})
    }
  }
  if (ownership.kind === 'ambiguous') {
    return { kind: 'error', error: MATERIALIZE_ONLY_ERROR_AMBIGUOUS }
  }
  const tabInOtherWorktree = Object.entries(state.tabsByWorktree).some(
    ([candidateWorktreeId, tabs]) =>
      candidateWorktreeId !== worktreeId && tabs.some((tab) => tab.id === tabId)
  )
  if (tabInOtherWorktree) {
    return { kind: 'error', error: MATERIALIZE_ONLY_ERROR_TAB_CONFLICT }
  }
  if (!state.getKnownWorktreeById(worktreeId)) {
    return { kind: 'error', error: MATERIALIZE_ONLY_ERROR_UNKNOWN_WORKTREE }
  }
  const tab = (state.tabsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === tabId)
  if (!tab) {
    return { kind: 'fresh' }
  }
  const layout = state.terminalLayoutsByTabId[tabId]
  const leafIds = collectLeafIdsInOrder(layout?.root)
  // Why: a tab that already holds this leaf for ANOTHER pty is not ours to overwrite; an empty or
  // unbound slot is claimable only while no other pty is recorded on the tab, or reconnect would
  // restore the wrong one over it.
  const tabRecordsAnotherPty = [tab.ptyId, state.pendingReconnectPtyIdByTabId[tabId]].some(
    (recorded) => recorded && recorded !== ptyId
  )
  // Why: a layout without a tree can still carry leaf bindings; filling would overwrite them.
  const offTreeBindingNamesAnotherPty = Object.values(layout?.ptyIdsByLeafId ?? {}).some(
    (bound) => bound && bound !== ptyId
  )
  if (leafIds.length === 0) {
    return tabRecordsAnotherPty || offTreeBindingNamesAnotherPty
      ? { kind: 'error', error: MATERIALIZE_ONLY_ERROR_TAB_CONFLICT }
      : { kind: 'fill-empty', tabId }
  }
  if (leafIds.includes(leafId)) {
    return layout?.ptyIdsByLeafId?.[leafId] || tabRecordsAnotherPty
      ? { kind: 'error', error: MATERIALIZE_ONLY_ERROR_TAB_CONFLICT }
      : { kind: 'bind-leaf', tabId }
  }
  const sourceLeafId =
    request.splitFromLeafId && leafIds.includes(request.splitFromLeafId)
      ? request.splitFromLeafId
      : layout?.activeLeafId && leafIds.includes(layout.activeLeafId)
        ? layout.activeLeafId
        : leafIds[0]!
  return { kind: 'add-leaf', tabId, sourceLeafId }
}
