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

const noopListener = (): (() => void) => () => {}

// Why a Proxy and not a literal: the hub touches dozens of namespaces on mount and this file cares
// about exactly one, so everything else answers a listener or a never-settling promise.
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

// `missing` names namespaces the api genuinely does NOT have — the shape of the hub suite's own plain
// object stubs, where an unguarded `window.api.<ns>.on…` throws rather than hitting a fallback.
function stubWindow(namespaces: Record<string, unknown>, missing: string[] = []): void {
  vi.stubGlobal('window', {
    api: new Proxy(namespaces, {
      get: (target, prop: string) =>
        missing.includes(prop) ? undefined : (target[prop] ?? autoStubNamespace)
    })
  })
}

// The hub reads several runtime methods after this lane; only the one registered directly below it
// needs to be observable, so the rest fall through to the same auto-stub shape.
function runtimeStub(fitOverrides: () => Promise<unknown[]>): unknown {
  return new Proxy({ getTerminalFitOverrides: fitOverrides } as Record<string, unknown>, {
    get: (target, prop: string) =>
      target[prop] ??
      ((...args: unknown[]) =>
        typeof args[0] === 'function' ? noopListener() : Promise.resolve([]))
  })
}

function mockHubDependencies(state: StoreState): void {
  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() }
  })
  vi.doMock('../store', () => ({
    useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => state }
  }))
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
    mockHubDependencies(state)
    stubWindow({
      terminalPresence: {
        get: () => Promise.resolve(SNAPSHOT),
        onChanged: (callback: (terminal: TerminalPresenceLocalTerminal) => void) => {
          pushes.push(callback)
          return () => {}
        }
      }
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
    const pushes: ((terminal: TerminalPresenceLocalTerminal) => void)[] = []
    mockHubDependencies(state)
    stubWindow({
      // The web client's preload fallback: an unknown namespace answers `undefined`, not a roster.
      terminalPresence: {
        get: () => Promise.resolve(undefined),
        onChanged: (callback: (terminal: TerminalPresenceLocalTerminal) => void) => {
          pushes.push(callback)
          return () => {}
        }
      }
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

    // And the lane reached a terminal state rather than buffering forever behind a hydration that is
    // never coming: a later push is applied instead of appended to a queue nothing drains.
    pushes[0]({ ptyId: PTY_ID, handle: 'terminal-7', participants: [PEER] })
    expect(presence.getPeerPresenceForPty(PTY_ID).map((row) => row.label)).toEqual(['Ana laptop'])
    vi.mocked(console.error).mockRestore()
  })

  it('leaves the rest of the hub standing when the api has no terminalPresence namespace', async () => {
    vi.resetModules()
    const state = makeState()
    const fitOverrides = vi.fn(() => Promise.resolve([]))
    mockHubDependencies(state)
    // Negative control for the namespace guard: a renderer whose api stub lacks the key must not throw
    // out of the effect and abandon every listener registered after this lane.
    stubWindow({ runtime: runtimeStub(fitOverrides) }, ['terminalPresence'])

    const { useIpcEvents } = await import('./useIpcEvents')
    expect(() => useIpcEvents()).not.toThrow()
    expect(fitOverrides).toHaveBeenCalled()
  })

  it('survives a stub whose get() answers something that is not a promise', async () => {
    vi.resetModules()
    const state = makeState()
    const fitOverrides = vi.fn(() => Promise.resolve([]))
    mockHubDependencies(state)
    // The catch-all namespace stub shared by the hub harness answers every method with `() => () => {}`,
    // so the round trip must tolerate a non-thenable rather than throwing inside the effect.
    stubWindow({
      terminalPresence: { get: () => () => {}, onChanged: () => () => {} },
      runtime: runtimeStub(fitOverrides)
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    expect(() => useIpcEvents()).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(fitOverrides).toHaveBeenCalled()
  })
})
