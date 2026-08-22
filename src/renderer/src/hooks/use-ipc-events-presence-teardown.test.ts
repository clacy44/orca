// Why its own file driving the real hook: the leak this covers was "the clearer is exported and nobody
// calls it", so a test that calls the clearer itself would prove nothing. Only mounting useIpcEvents and
// walking an environment out of the desired set exercises the wiring.
import type * as ReactModule from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
    settings: { activeRuntimeEnvironmentId: 'env-1' },
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

const HOST_ROW = {
  participantId: 'host',
  label: 'devbox',
  kind: 'host' as const,
  attachedTerminals: [],
  self: false
}

describe('useIpcEvents presence roster teardown', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('empties the People section for an environment that leaves the desired set', async () => {
    vi.resetModules()
    const state = makeState()
    const subscribers: ((...args: unknown[]) => void)[] = []
    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() }
    })
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn((listener: (...args: unknown[]) => void) => {
          subscribers.push(listener)
          return () => {}
        }),
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
      api: new Proxy({} as Record<string, unknown>, {
        get: (target, prop: string) => target[prop] ?? autoStubNamespace
      })
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    // Why imported here and not at the top of the file: vi.resetModules() gives the hook a fresh module
    // graph, so a statically imported state module would be a different map than the one it writes.
    const presence = await import('../lib/pane-manager/terminal-presence-state')
    useIpcEvents()
    presence.setPresenceRosterForEnvironment('env-1', { participants: [HOST_ROW] })
    expect(presence.getPresenceRosterEnvironmentIds()).toEqual(['env-1'])

    // The runtime is unpaired / removed: it leaves the desired set, so its clientEvents subscription
    // is torn down and no later frame can ever correct the roster it left behind.
    state.settings.activeRuntimeEnvironmentId = null
    subscribers.forEach((listener) => listener(state, state))

    expect(presence.getPresenceRosterEnvironmentIds()).toEqual([])
  })
})
