// A terminal created with explicit background presentation (automation, orchestration worker,
// lane wake ...) has no tab on purpose; the live-surface reconcile must not give it one.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot
} from '../crash-reporting/crash-breadcrumb-store'

const REPO_ID = 'repo-bg'
const REPO_PATH = '/tmp/repo-bg'
const WORKTREE_PATH = '/tmp/worktree-bg'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const TAB_ID = 'tab-bg'
const LEAF_ID = '88888888-8888-4888-8888-888888888888'
const PTY_ID = 'pty-bg-1'

// Why mocked: workspace-selector resolution shells out to `git worktree list`.
const MOCK_GIT_WORKTREES = vi.hoisted(() => [
  { path: '/tmp/worktree-bg', head: 'abc', branch: 'main', isBare: false, isMainWorktree: false }
])
vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  listWorktreesStrict: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  assertWorktreeCleanForRemoval: vi.fn().mockResolvedValue(undefined),
  addWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  forceDeleteLocalBranch: vi.fn()
}))

type ListedProcess = {
  id: string
  cwd: string
  worktreeId: string
  terminalHandle?: string
  incarnationId?: string
}

function createRuntime(extraListed: ListedProcess[] = []) {
  const session = getDefaultWorkspaceSession()
  const store = {
    getRepo: () => store.getRepos()[0],
    getRepos: () => [
      { id: REPO_ID, path: REPO_PATH, displayName: 'bg', badgeColor: 'blue', addedAt: 1 }
    ],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => undefined as never,
    removeWorktreeMeta: () => {},
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => [],
    getWorkspaceSession: () => session,
    isWritesFrozen: () => false
  }
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setPtyController({
    spawn: async (args: { tabId?: string; leafId?: string }) => {
      runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
        tabId: args.tabId!,
        leafId: args.leafId!,
        incarnationId: 'bg-incarnation'
      })
      return { id: PTY_ID, incarnationId: 'bg-incarnation' }
    },
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [
      {
        id: PTY_ID,
        cwd: WORKTREE_PATH,
        worktreeId: WORKTREE_ID,
        terminalHandle: 'term_bg',
        incarnationId: 'bg-incarnation'
      },
      ...extraListed
    ]
  } as never)
  const reveal = vi.fn(
    async (
      worktree: string,
      opts: { tabId?: string; leafId?: string; ptyId: string; materializeOnly?: boolean }
    ) => ({
      tabId: opts.tabId,
      identity: { worktreeId: worktree, tabId: opts.tabId, leafId: opts.leafId, ptyId: opts.ptyId }
    })
  )
  runtime.setNotifier({ revealTerminalSession: reveal } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  return { runtime, reveal }
}

function create(runtime: OrcaRuntimeService, presentation?: 'background') {
  return runtime.createTerminal(`path:${WORKTREE_PATH}`, {
    restoreProvenance: { kind: 'none' },
    credentialLane: { kind: 'shared' },
    tabId: TAB_ID,
    leafId: LEAF_ID,
    title: 'bg',
    ...(presentation ? { presentation } : {})
  })
}

describe('live-surface reconcile and background-created terminals', () => {
  it('does not give an explicit background terminal a tab', async () => {
    const { runtime, reveal } = createRuntime()
    await create(runtime, 'background')
    reveal.mockClear()

    await runtime.reconcileLiveTerminalSurfacesForRenderer()

    expect(reveal).not.toHaveBeenCalled()
  })

  it('positive control: a terminal created for the renderer is re-shown by the reconcile', async () => {
    const { runtime, reveal } = createRuntime()
    await create(runtime)
    reveal.mockClear()

    await runtime.reconcileLiveTerminalSurfacesForRenderer()

    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal.mock.calls[0]![1]).toMatchObject({ ptyId: PTY_ID, materializeOnly: true })
  })

  it('re-shows a background terminal once something revealed it into a tab and the renderer died', async () => {
    const { runtime, reveal } = createRuntime()
    const terminal = await create(runtime, 'background')
    // User focuses the terminal: the existing reveal path gives it a tab, so it is no longer tab-less by design.
    await runtime.focusTerminal(terminal.handle)
    reveal.mockClear()

    await runtime.reconcileLiveTerminalSurfacesForRenderer()

    expect(reveal).toHaveBeenCalledTimes(1)
  })

  describe('a graph sync that shows the terminal in a leaf', () => {
    function syncLeaf(runtime: OrcaRuntimeService, ptyId: string | null): void {
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: TAB_ID,
            worktreeId: WORKTREE_ID,
            title: 'bg',
            activeLeafId: LEAF_ID,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: TAB_ID,
            worktreeId: WORKTREE_ID,
            leafId: LEAF_ID,
            paneRuntimeId: 1,
            ptyId
          }
        ]
      })
    }

    it('makes a background terminal a candidate, though nothing revealed it', async () => {
      const { runtime, reveal } = createRuntime()
      await create(runtime, 'background')
      syncLeaf(runtime, PTY_ID)
      reveal.mockClear()

      await runtime.reconcileLiveTerminalSurfacesForRenderer()

      expect(reveal).toHaveBeenCalledTimes(1)
      expect(reveal.mock.calls[0]![1]).toMatchObject({ ptyId: PTY_ID })
    })

    it('positive control: a background terminal no leaf ever showed stays excluded', async () => {
      const { runtime, reveal } = createRuntime()
      await create(runtime, 'background')
      // A graph that shows a leaf for some other pty, and one that shows this leaf unbound.
      syncLeaf(runtime, 'pty-unrelated')
      syncLeaf(runtime, null)
      reveal.mockClear()

      await runtime.reconcileLiveTerminalSurfacesForRenderer()

      expect(reveal).not.toHaveBeenCalled()
    })
  })

  describe('reconcile breadcrumb', () => {
    function reconcileBreadcrumbs() {
      return getCrashBreadcrumbSnapshot().filter(
        (crumb) => crumb.name === 'live_terminal_surface_reconcile'
      )
    }
    // Listed without a controller identity while the record claims an incarnation: a mismatch.
    const MISMATCH: ListedProcess = {
      id: 'pty-mismatch',
      cwd: WORKTREE_PATH,
      worktreeId: WORKTREE_ID
    }

    function registerMismatch(runtime: OrcaRuntimeService): void {
      runtime.registerPty('pty-mismatch', WORKTREE_ID, null, {
        tabId: 'tab-mismatch',
        leafId: '99999999-9999-4999-8999-999999999999',
        incarnationId: 'stale-incarnation'
      })
    }

    it('counts each skip reason, and is emitted although nothing is left to reveal', async () => {
      const { runtime, reveal } = createRuntime([MISMATCH])
      await create(runtime, 'background')
      registerMismatch(runtime)
      reveal.mockClear()
      clearCrashBreadcrumbsForTest()

      await runtime.reconcileLiveTerminalSurfacesForRenderer()

      expect(reveal).not.toHaveBeenCalled()
      expect(reconcileBreadcrumbs().map((crumb) => crumb.data)).toEqual([
        {
          outcome: 'nothing_to_reveal',
          skip_surfaceless_background: 1,
          skip_incarnation_mismatch: 1
        }
      ])
    })

    it('carries the skip counts next to the drain summary when something is revealed', async () => {
      const { runtime, reveal } = createRuntime([
        MISMATCH,
        { id: 'pty-shown', cwd: WORKTREE_PATH, worktreeId: WORKTREE_ID }
      ])
      await create(runtime, 'background')
      registerMismatch(runtime)
      runtime.registerPty('pty-shown', WORKTREE_ID, null, {
        tabId: 'tab-shown',
        leafId: '77777777-7777-4777-8777-777777777777'
      })
      reveal.mockClear()
      clearCrashBreadcrumbsForTest()

      await runtime.reconcileLiveTerminalSurfacesForRenderer()

      expect(reveal).toHaveBeenCalledTimes(1)
      expect(reconcileBreadcrumbs().map((crumb) => crumb.data)).toEqual([
        expect.objectContaining({
          outcome: 'done',
          revealed: 1,
          skip_surfaceless_background: 1,
          skip_incarnation_mismatch: 1
        })
      ])
    })
  })
})
