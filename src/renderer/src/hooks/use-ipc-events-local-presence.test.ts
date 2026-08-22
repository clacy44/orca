// Why its own file driving the real hook: the lane is only wired if the hub registers it, so a test
// that called the lane directly would prove the projection and nothing about the wiring.
import type * as ReactModule from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  TerminalPresenceLocalSnapshot,
  TerminalPresenceLocalTerminal
} from '../../../shared/terminal-presence-ipc'

type StoreState = {
  settings: { activeRuntimeEnvironmentId: string | null }
  runtimeEnvironments: unknown[]
  runtimeStatusByEnvironmentId: Map<string, unknown>
  tabsByWorktree: Record<string, unknown>
  ptyIdsByTabId: Record<string, unknown>
  repos: unknown[]
  worktreesByRepo: Record<string, unknown>
  folderWorkspaces: unknown[]
  projectGroups: unknown[]
  markEnvironmentSshStateStale: () => void
  remountTerminalTabForRecovery: () => void
  fetchRepos: () => Promise<void>
  fetchRuntimeEnvironmentRepos: () => Promise<unknown[]>
  fetchProjectGroups: () => Promise<void>
  fetchFolderWorkspaces: () => Promise<void>
  fetchWorktrees: () => Promise<void>
  fetchWorktreeLineage: () => Promise<void>
}

function makeState(): StoreState {
  return {
    settings: { activeRuntimeEnvironmentId: null },
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    repos: [],
    worktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    markEnvironmentSshStateStale: vi.fn(),
    remountTerminalTabForRecovery: vi.fn(),
    fetchRepos: vi.fn(() => Promise.resolve()),
    fetchRuntimeEnvironmentRepos: vi.fn(() => Promise.resolve([])),
    fetchProjectGroups: vi.fn(() => Promise.resolve()),
    fetchFolderWorkspaces: vi.fn(() => Promise.resolve()),
    fetchWorktrees: vi.fn(() => Promise.resolve()),
    fetchWorktreeLineage: vi.fn(() => Promise.resolve())
  }
}

const PTY_ID = 'pty-local-1'

const PEER = {
  participantId: 'p-ana',
  label: 'Ana laptop',
  kind: 'runtime' as const,
  self: false,
  typing: false,
  writing: false,
  since: 1_000
}

const SNAPSHOT: TerminalPresenceLocalSnapshot = {
  host: { participantId: 'host', label: 'devbox', kind: 'host', self: true },
  terminals: [{ ptyId: PTY_ID, handle: 'terminal-7', participants: [PEER] }]
}

describe('useIpcEvents local presence lane', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('registers the change listener and hydrates the pane lane on mount', async () => {
    vi.resetModules()
    const state = makeState()
    const pushes: ((terminal: TerminalPresenceLocalTerminal) => void)[] = []
    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() }
    })
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => state
      }
    }))
    const noopListener = (): (() => void) => () => {}
    const autoStubNamespace = new Proxy(
      {},
      {
        get:
          () =>
          (...args: unknown[]) => {
            if (typeof args[0] === 'function') {
              return noopListener()
            }
            return new Promise(() => {})
          }
      }
    )
    vi.stubGlobal('window', {
      api: new Proxy(
        {
          terminalPresence: {
            get: () => Promise.resolve(SNAPSHOT),
            onChanged: (callback: (terminal: TerminalPresenceLocalTerminal) => void) => {
              pushes.push(callback)
              return () => {}
            }
          }
        } as Record<string, unknown>,
        { get: (target, prop: string) => target[prop] ?? autoStubNamespace }
      )
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    // Why imported here: vi.resetModules() gives the hook a fresh module graph, so a statically
    // imported state module would be a different map than the one it writes.
    const presence = await import('../lib/pane-manager/terminal-presence-state')
    useIpcEvents()
    await Promise.resolve()
    await Promise.resolve()

    expect(pushes).toHaveLength(1)
    expect(presence.getPeerPresenceForPty(PTY_ID).map((row) => row.label)).toEqual(['Ana laptop'])

    pushes[0]({ ptyId: PTY_ID, handle: 'terminal-7', participants: [{ ...PEER, typing: true }] })

    expect(presence.getPeerPresenceForPty(PTY_ID)[0]?.typing).toBe(true)
  })

  it('stays empty when the preload answers with no snapshot at all', async () => {
    vi.resetModules()
    const state = makeState()
    const errors: unknown[] = []
    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() }
    })
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => state }
    }))
    const noopListener = (): (() => void) => () => {}
    const autoStubNamespace = new Proxy(
      {},
      {
        get:
          () =>
          (...args: unknown[]) => {
            if (typeof args[0] === 'function') {
              return noopListener()
            }
            return new Promise(() => {})
          }
      }
    )
    vi.stubGlobal('window', {
      api: new Proxy(
        {
          // The web client's preload fallback: an unknown namespace answers `undefined`, not a roster.
          terminalPresence: {
            get: () => Promise.resolve(undefined),
            onChanged: () => () => {}
          }
        } as Record<string, unknown>,
        { get: (target, prop: string) => target[prop] ?? autoStubNamespace }
      )
    })
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args)
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    const presence = await import('../lib/pane-manager/terminal-presence-state')
    useIpcEvents()
    await Promise.resolve()
    await Promise.resolve()

    // Negative control for the guard: no local host means no rows and no logged failure.
    expect(presence.getPresenceRosterEnvironmentIds()).toEqual([])
    expect(errors).toEqual([])
    vi.mocked(console.error).mockRestore()
  })
})
