// Why a dedicated file: keeps terminal-parked-tab-watchers.test.ts under the
// oxlint max-lines(800) cap instead of suppressing the rule (see AGENTS.md).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

const WORKTREE_ID = 'repo::/worktree'
const OTHER_WORKTREE_ID = 'repo::/other-worktree'

type StartedWatcher = {
  options: ParkedTerminalByteWatcherOptions
  dispose: ReturnType<typeof vi.fn>
}

const startedWatchers: StartedWatcher[] = []
const startParkedTerminalByteWatcher = vi.fn((options: ParkedTerminalByteWatcherOptions) => {
  const dispose = vi.fn()
  startedWatchers.push({ options, dispose })
  return dispose
})

vi.mock('./parked-terminal-byte-watcher', () => ({
  startParkedTerminalByteWatcher: (options: ParkedTerminalByteWatcherOptions) =>
    startParkedTerminalByteWatcher(options)
}))

const subscribeToPtyExit = vi.fn((_ptyId: string, _callback: (code: number) => void) => vi.fn())
vi.mock('./pty-dispatcher', () => ({
  subscribeToPtyExit: (ptyId: string, callback: (code: number) => void) =>
    subscribeToPtyExit(ptyId, callback)
}))

vi.mock('./pty-pre-handler-buffer', () => ({
  discardPreHandlerPtyState: vi.fn()
}))

vi.mock('../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: vi.fn()
}))

type MockStoreState = {
  tabsByWorktree: Record<
    string,
    { id: string; launchAgent?: 'claude' | 'codex'; ptyId: string | null }[]
  >
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  settings: { terminalSshViewParking?: boolean } | null
  runtimeStatusByEnvironmentId: Map<
    string,
    { status: { capabilities?: string[] } | null; checkedAt: number }
  >
  clearTabLaunchAgent: ReturnType<typeof vi.fn>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  setRuntimePaneTitle: ReturnType<typeof vi.fn>
  setTabLayout: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn>
}

let mockStoreState: MockStoreState

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState }
}))

import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities
} from '../terminal/terminal-provider-snapshot-capability'
import {
  pruneParkedTerminalWatchers,
  syncParkedTerminalTabWatchers
} from './terminal-parked-tab-watchers'
import { buildTitleDerivedAgentRows } from '../sidebar/worktree-title-derived-agent-rows'

const originalWindow = (globalThis as { window?: unknown }).window

beforeEach(() => {
  mockStoreState = {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    settings: null,
    runtimeStatusByEnvironmentId: new Map(),
    clearTabLaunchAgent: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    setRuntimePaneTitle: vi.fn(),
    setTabLayout: vi.fn(),
    updateTabTitle: vi.fn()
  }
  ;(globalThis as { window?: unknown }).window = { api: { pty: { write: vi.fn() } } }
  clearTerminalProviderSnapshotCapabilities()
})

afterEach(() => {
  pruneParkedTerminalWatchers(new Set())
  startedWatchers.length = 0
  vi.clearAllMocks()
  clearTerminalProviderSnapshotCapabilities()
  ;(globalThis as { window?: unknown }).window = originalWindow
})

describe('terminal-parked-tab-watchers startup restore (R113)', () => {
  it('restores titles for every live-pty tab across two unmounted worktrees at startup, yielding one sidebar row each', async () => {
    const TAB_A1 = 'startup-tab-a1'
    const TAB_A2 = 'startup-tab-a2'
    const TAB_B1 = 'startup-tab-b1'
    const PTY_A1 = `${WORKTREE_ID}@@startup-1`
    const PTY_A2 = `${WORKTREE_ID}@@startup-2`
    const PTY_B1 = `${OTHER_WORKTREE_ID}@@startup-1`
    const LEAF_A1 = 'aaaaaaa1-1111-4111-8111-111111111111'
    const LEAF_A2 = 'aaaaaaa2-2222-4222-8222-222222222222'
    const LEAF_B1 = 'bbbbbbb1-1111-4111-8111-111111111111'

    mockStoreState.terminalLayoutsByTabId[TAB_A1] = {
      root: { type: 'leaf', leafId: LEAF_A1 },
      activeLeafId: LEAF_A1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_A1]: PTY_A1 }
    }
    mockStoreState.terminalLayoutsByTabId[TAB_A2] = {
      root: { type: 'leaf', leafId: LEAF_A2 },
      activeLeafId: LEAF_A2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_A2]: PTY_A2 }
    }
    mockStoreState.terminalLayoutsByTabId[TAB_B1] = {
      root: { type: 'leaf', leafId: LEAF_B1 },
      activeLeafId: LEAF_B1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_B1]: PTY_B1 }
    }
    await synchronizeTerminalProviderSnapshotCapabilities([PTY_A1, PTY_A2, PTY_B1], async (ids) =>
      ids.map((id) => ({ id, authoritative: true }))
    )

    const worktreeATabs = [
      { id: TAB_A1, ptyId: PTY_A1 },
      { id: TAB_A2, ptyId: PTY_A2 }
    ]
    const worktreeBTabs = [{ id: TAB_B1, ptyId: PTY_B1 }]

    // Mirrors the Terminal.tsx startup effect: sync every unmounted worktree once,
    // restoring the title for every live-pty tab independent of the lazy-mount gate.
    syncParkedTerminalTabWatchers({
      worktreeId: WORKTREE_ID,
      tabs: worktreeATabs,
      parkedTabIds: new Set([TAB_A1, TAB_A2]),
      restoreTitleOnStartTabIds: new Set([TAB_A1, TAB_A2])
    })
    syncParkedTerminalTabWatchers({
      worktreeId: OTHER_WORKTREE_ID,
      tabs: worktreeBTabs,
      parkedTabIds: new Set([TAB_B1]),
      restoreTitleOnStartTabIds: new Set([TAB_B1])
    })

    expect(startedWatchers).toHaveLength(3)
    expect(
      startedWatchers.every((watcher) => watcher.options.restoreTitleOnRegister === true)
    ).toBe(true)

    // Once each watcher's cold snapshot restores the title, the sidebar row builder sees three rows.
    const rows = buildTitleDerivedAgentRows({
      tabs: [
        {
          id: TAB_A1,
          worktreeId: WORKTREE_ID,
          ptyId: PTY_A1,
          title: 'Claude Code',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        },
        {
          id: TAB_A2,
          worktreeId: WORKTREE_ID,
          ptyId: PTY_A2,
          title: 'Claude Code',
          customTitle: null,
          color: null,
          sortOrder: 1,
          createdAt: 0
        },
        {
          id: TAB_B1,
          worktreeId: OTHER_WORKTREE_ID,
          ptyId: PTY_B1,
          title: 'Claude Code',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ],
      runtimePaneTitlesByTabId: {
        [TAB_A1]: { 1: 'Claude Code' },
        [TAB_A2]: { 1: 'Claude Code' },
        [TAB_B1]: { 1: 'Claude Code' }
      },
      ptyIdsByTabId: {
        [TAB_A1]: [PTY_A1],
        [TAB_A2]: [PTY_A2],
        [TAB_B1]: [PTY_B1]
      },
      terminalLayoutsByTabId: mockStoreState.terminalLayoutsByTabId,
      seenPaneKeys: new Set(),
      now: 1000
    })

    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.agentType === 'claude')).toBe(true)
  })
})
