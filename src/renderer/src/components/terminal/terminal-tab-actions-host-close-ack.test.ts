import { describe, expect, it, vi } from 'vitest'

// Why a dedicated file: terminal-tab-actions.test.ts is at the max-lines
// ratchet ceiling — these tests cover H8 (a remote-host tab's close acking
// its agent completion even when a mirror snapshot prunes the tab row in
// flight, before the host close resolves) and don't fit there.

const {
  closeWebRuntimeSessionTabMock,
  getStateMock,
  isWebRuntimeSessionActiveMock,
  resolveHostSessionTabIdForWebSessionTabMock,
  toHostSessionTabIdMock
} = vi.hoisted(() => ({
  closeWebRuntimeSessionTabMock: vi.fn(),
  getStateMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn(),
  resolveHostSessionTabIdForWebSessionTabMock: vi.fn<() => string | null>(() => null),
  toHostSessionTabIdMock: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock,
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock,
  isWebTerminalSurfaceTabId: vi.fn(() => false),
  toHostSessionTabId: toHostSessionTabIdMock
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: vi.fn(() => 'epoch-1'),
  resolveHostSessionTabIdForWebSessionTab: resolveHostSessionTabIdForWebSessionTabMock
}))

import { closeTerminalTab } from './terminal-tab-actions'
import { collectRetainedAgentsOnDisappear } from '@/components/dashboard/useRetainedAgents'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeTab,
  seedStore
} from '@/store/slices/store-test-helpers'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

const WORKTREE_ID = 'repo1::/repo1/worktree'
const TAB_ID = 'web-terminal-x'
const PANE_KEY = `${TAB_ID}:leaf1`

function makeDoneEntry(): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'Fix it',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude',
    interrupted: false,
    worktreeId: WORKTREE_ID
  }
}

describe('closeTerminalTab acking a remote-host tab close (H8)', () => {
  it('T1: acknowledges via dropAgentStatusByTabPrefix when a mirror snapshot beats the host close', async () => {
    const dropAgentStatusByTabPrefix = vi.fn()
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab-1')

    const baseState = {
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      tabsByWorktree: { [WORKTREE_ID]: [{ id: TAB_ID }] },
      unifiedTabsByWorktree: {},
      activeWorktreeId: WORKTREE_ID,
      activeTabId: TAB_ID,
      closeTab,
      setActiveTab: vi.fn(),
      dropAgentStatusByTabPrefix
    }
    getStateMock.mockReturnValue(baseState)

    closeWebRuntimeSessionTabMock.mockImplementation(async () => {
      // Why: simulate a mirror snapshot landing in flight — it prunes the tab
      // row and mints the retained "done" snapshot before the host resolves.
      getStateMock.mockReturnValue({
        ...baseState,
        tabsByWorktree: {},
        unifiedTabsByWorktree: {},
        retainedAgentsByPaneKey: { [PANE_KEY]: { entry: makeDoneEntry() } }
      })
      return true
    })

    await closeTerminalTab(TAB_ID, { skipRunningProcessConfirm: true })

    expect(dropAgentStatusByTabPrefix).toHaveBeenCalledWith(TAB_ID, {
      preserveRetainedSnapshot: false
    })
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('T2: real store — retained snapshot drops and the closed-tab marker is set', async () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeRuntimeOwnedWorktree(
            { id: WORKTREE_ID, repoId: 'repo1', path: '/repo1/worktree' },
            'web-runtime'
          )
        ]
      },
      tabsByWorktree: { [WORKTREE_ID]: [makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID })] }
    })
    const retained: RetainedAgentEntry = {
      entry: makeDoneEntry(),
      worktreeId: WORKTREE_ID,
      tab: makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID }),
      agentType: 'claude',
      startedAt: 1
    }
    store.setState({ agentStatusByPaneKey: { [PANE_KEY]: makeDoneEntry() } })

    getStateMock.mockImplementation(() => store.getState())
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue(null)

    closeWebRuntimeSessionTabMock.mockImplementation(async () => {
      // Why: simulate the mirror sync's direct tabsByWorktree write (H8 chain)
      // landing before the host close resolves — the live 'done' row becomes
      // a retained snapshot without touching recentlyClosedAgentStatusTabIds.
      store.setState((s) => {
        const nextLive = { ...s.agentStatusByPaneKey }
        delete nextLive[PANE_KEY]
        return {
          tabsByWorktree: { ...s.tabsByWorktree, [WORKTREE_ID]: [] },
          agentStatusByPaneKey: nextLive,
          retainedAgentsByPaneKey: { ...s.retainedAgentsByPaneKey, [PANE_KEY]: retained }
        }
      })
      return true
    })

    await closeTerminalTab(TAB_ID, { skipRunningProcessConfirm: true })

    expect(store.getState().retainedAgentsByPaneKey[PANE_KEY]).toBeUndefined()
    expect(store.getState().recentlyClosedAgentStatusTabIds[TAB_ID]).toBe(true)
  })

  it('T3: fence — a non-user (cleanup) close leaves the retained snapshot standing', async () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeRuntimeOwnedWorktree(
            { id: WORKTREE_ID, repoId: 'repo1', path: '/repo1/worktree' },
            'web-runtime'
          )
        ]
      },
      tabsByWorktree: { [WORKTREE_ID]: [makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID })] }
    })
    const retained: RetainedAgentEntry = {
      entry: makeDoneEntry(),
      worktreeId: WORKTREE_ID,
      tab: makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID }),
      agentType: 'claude',
      startedAt: 1
    }
    store.setState({ agentStatusByPaneKey: { [PANE_KEY]: makeDoneEntry() } })

    getStateMock.mockImplementation(() => store.getState())
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue(null)

    closeWebRuntimeSessionTabMock.mockImplementation(async () => {
      store.setState((s) => {
        const nextLive = { ...s.agentStatusByPaneKey }
        delete nextLive[PANE_KEY]
        return {
          tabsByWorktree: { ...s.tabsByWorktree, [WORKTREE_ID]: [] },
          agentStatusByPaneKey: nextLive,
          retainedAgentsByPaneKey: { ...s.retainedAgentsByPaneKey, [PANE_KEY]: retained }
        }
      })
      return true
    })

    await closeTerminalTab(TAB_ID, { reason: 'cleanup', skipRunningProcessConfirm: true })

    expect(store.getState().retainedAgentsByPaneKey[PANE_KEY]).toBeDefined()
  })

  it('T4: anchor — a closed-tab marker suppresses re-retention on disappearance', () => {
    const { toRetain } = collectRetainedAgentsOnDisappear({
      previousAgents: new Map([
        [
          PANE_KEY,
          {
            row: {
              paneKey: PANE_KEY,
              entry: makeDoneEntry(),
              tab: makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID }),
              agentType: 'claude',
              state: 'done',
              startedAt: 1
            },
            worktreeId: WORKTREE_ID
          }
        ]
      ]),
      currentAgents: new Map(),
      retainedAgentsByPaneKey: {},
      retentionSuppressedPaneKeys: {},
      recentlyClosedAgentStatusTabIds: { [TAB_ID]: true },
      recentlyRetiredAgentStatusPaneKeys: {}
    })

    expect(toRetain).toEqual([])
  })
})
