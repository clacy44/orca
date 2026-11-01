// Materialize-only reveal into a tab that already exists: claiming an unbound or empty slot, ownership
// recorded only in the pending reconnect map, and how the tab records its pty before/after reconnect.
import { describe, expect, it, vi } from 'vitest'
import {
  createHarnessStoreState,
  loadIpcEventsHarness,
  type HarnessStoreState
} from './ipc-events-test-harness'

const WORKTREE = 'wt-1'
const TAB = 'tab-live'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const request = {
  requestId: 'req-1',
  worktreeId: WORKTREE,
  ptyId: 'pty-b',
  tabId: TAB,
  leafId: LEAF_B,
  title: 'claude',
  materializeOnly: true,
  presentation: 'background' as const,
  activate: false,
  focus: false
}
const CONFLICT = { requestId: 'req-1', error: 'terminal_materialize_tab_conflict' }
const BOUND_B = { worktreeId: WORKTREE, tabId: TAB, leafId: LEAF_B, ptyId: 'pty-b' }

function layoutOf(ptyIdsByLeafId: Record<string, string>) {
  return {
    root: { type: 'leaf' as const, leafId: LEAF_B },
    activeLeafId: LEAF_B,
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

function stateWith(
  overrides: Partial<HarnessStoreState> & Pick<HarnessStoreState, 'tabsByWorktree'>
): HarnessStoreState {
  return createHarnessStoreState({
    getKnownWorktreeById: vi.fn((id: string) => (id === WORKTREE ? { id } : undefined)),
    pendingReconnectPtyIdByTabId: {},
    workspaceSessionReady: false,
    ...overrides
  })
}

async function load(storeState: HarnessStoreState) {
  const harness = await loadIpcEventsHarness(storeState)
  harness.useIpcEvents()
  return harness
}

describe('materialize-only reveal into an existing tab', () => {
  it('binds an unbound requested leaf to the pty without moving the active leaf or minting a tab', async () => {
    const storeState = stateWith({
      tabsByWorktree: { [WORKTREE]: [{ id: TAB, ptyId: null, title: 'Saved' }] },
      terminalLayoutsByTabId: {
        [TAB]: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: LEAF_A },
            second: { type: 'leaf', leafId: LEAF_B },
            ratio: 0.5
          },
          activeLeafId: LEAF_A,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_A]: 'pty-a' }
        }
      }
    })
    const harness = await load(storeState)

    harness.createTerminal(request)

    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(storeState.setTabLayout).toHaveBeenCalledWith(
      TAB,
      expect.objectContaining({
        activeLeafId: LEAF_A,
        ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b' },
        titlesByLeafId: { [LEAF_B]: 'claude' }
      })
    )
    expect(storeState.setActiveTab).not.toHaveBeenCalled()
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-1',
      tabId: TAB,
      title: 'claude',
      identity: BOUND_B
    })
  })

  it('refuses to rebind a leaf that is bound to another pty', async () => {
    const storeState = stateWith({
      tabsByWorktree: { [WORKTREE]: [{ id: TAB, ptyId: null, title: 'Saved' }] },
      terminalLayoutsByTabId: { [TAB]: layoutOf({ [LEAF_B]: 'pty-other' }) }
    })
    const harness = await load(storeState)

    harness.createTerminal(request)

    expect(harness.replyTerminalCreate).toHaveBeenCalledWith(CONFLICT)
    expect(storeState.setTabLayout).not.toHaveBeenCalled()
  })

  it('refuses to claim the slot while the tab records another pty at tab level or pending', async () => {
    for (const tabState of [
      { tabs: [{ id: TAB, ptyId: 'pty-other', title: 'Saved' }], pending: {} },
      { tabs: [{ id: TAB, ptyId: null, title: 'Saved' }], pending: { [TAB]: 'pty-other' } }
    ]) {
      const storeState = stateWith({
        tabsByWorktree: { [WORKTREE]: tabState.tabs },
        terminalLayoutsByTabId: { [TAB]: layoutOf({}) },
        pendingReconnectPtyIdByTabId: tabState.pending
      })
      const harness = await load(storeState)

      harness.createTerminal(request)

      expect(harness.replyTerminalCreate).toHaveBeenCalledWith(CONFLICT)
      expect(storeState.setTabLayout).not.toHaveBeenCalled()
      expect(storeState.updateTabPtyId).not.toHaveBeenCalled()
    }
  })

  it('fills a tab that has no layout with the requested leaf', async () => {
    const storeState = stateWith({
      tabsByWorktree: { [WORKTREE]: [{ id: TAB, ptyId: null, title: 'Saved' }] }
    })
    const harness = await load(storeState)

    harness.createTerminal(request)

    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(storeState.setTabLayout).toHaveBeenCalledWith(TAB, {
      root: { type: 'leaf', leafId: LEAF_B },
      activeLeafId: LEAF_B,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_B]: 'pty-b' },
      titlesByLeafId: { [LEAF_B]: 'claude' }
    })
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-1',
      tabId: TAB,
      title: 'claude',
      identity: BOUND_B
    })
  })

  it('refuses to fill an empty tab that records another pty', async () => {
    const storeState = stateWith({
      tabsByWorktree: { [WORKTREE]: [{ id: TAB, ptyId: 'pty-other', title: 'Saved' }] }
    })
    const harness = await load(storeState)

    harness.createTerminal(request)

    expect(harness.replyTerminalCreate).toHaveBeenCalledWith(CONFLICT)
    expect(storeState.setTabLayout).not.toHaveBeenCalled()
  })

  it('replies owned when only the pending reconnect map records the pty on a tab', async () => {
    const storeState = stateWith({
      tabsByWorktree: { [WORKTREE]: [{ id: 'tab-restored', ptyId: null, title: 'Restored' }] },
      pendingReconnectPtyIdByTabId: { 'tab-restored': 'pty-b' }
    })
    const harness = await load(storeState)

    harness.createTerminal(request)

    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-1',
      tabId: 'tab-restored',
      title: 'claude',
      skipped: 'owned'
    })
    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(storeState.setTabLayout).not.toHaveBeenCalled()
  })
})

describe('how a materialized tab records its pty', () => {
  const liveLayout = {
    root: { type: 'leaf' as const, leafId: LEAF_A },
    activeLeafId: LEAF_A,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_A]: 'pty-a' }
  }
  const addLeafState = (ready: boolean) =>
    stateWith({
      tabsByWorktree: { [WORKTREE]: [{ id: TAB, ptyId: 'pty-a', title: 'Live' }] },
      ptyIdsByTabId: { [TAB]: ['pty-a'] },
      terminalLayoutsByTabId: { [TAB]: liveLayout },
      workspaceSessionReady: ready
    })

  it('before reconnect finished, an added leaf is recorded in the pending reconnect map', async () => {
    const storeState = addLeafState(false)
    const harness = await load(storeState)

    harness.createTerminal({ ...request, splitFromLeafId: LEAF_A })

    expect(storeState.pendingReconnectPtyIdByTabId).toEqual({ [TAB]: 'pty-b' })
    expect(storeState.updateTabPtyId).not.toHaveBeenCalled()
  })

  it('once reconnect finished, an added leaf is bound with updateTabPtyId and leaves no pending entry', async () => {
    const storeState = addLeafState(true)
    const harness = await load(storeState)

    harness.createTerminal({ ...request, splitFromLeafId: LEAF_A })

    expect(storeState.updateTabPtyId).toHaveBeenCalledWith(TAB, 'pty-b')
    expect(storeState.pendingReconnectPtyIdByTabId).toEqual({})
  })

  it.each([
    { name: 'a bound slot', layout: layoutOf({}) },
    { name: 'a filled empty tab', layout: undefined }
  ])('applies the same rule to $name', async ({ layout }) => {
    for (const ready of [false, true]) {
      const storeState = stateWith({
        tabsByWorktree: { [WORKTREE]: [{ id: TAB, ptyId: null, title: 'Saved' }] },
        ...(layout ? { terminalLayoutsByTabId: { [TAB]: layout } } : {}),
        workspaceSessionReady: ready
      })
      const harness = await load(storeState)

      harness.createTerminal(request)

      if (ready) {
        expect(storeState.updateTabPtyId).toHaveBeenCalledWith(TAB, 'pty-b')
        expect(storeState.pendingReconnectPtyIdByTabId).toEqual({})
      } else {
        expect(storeState.updateTabPtyId).not.toHaveBeenCalled()
        expect(storeState.pendingReconnectPtyIdByTabId).toEqual({ [TAB]: 'pty-b' })
      }
    }
  })
})
