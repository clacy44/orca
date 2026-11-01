// The liveness rounds before each reveal run one after another, each up to the controller's list
// timeout; the whole drain must still end inside its startup budget.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { LIVE_SURFACE_RECONCILE_BUDGET_MS } from './live-terminal-surface-reconcile'
import { getDefaultWorkspaceSession } from '../../shared/constants'

const REPO_ID = 'repo-budget'
const REPO_PATH = '/tmp/repo-budget'
const WORKTREE_PATH = '/tmp/worktree-budget'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const LEAF_ID = '66666666-6666-4666-8666-666666666666'
const SLOW_LIST_MS = 2_900
const ITEM_COUNT = 8

// Why mocked: workspace-selector resolution shells out to `git worktree list`.
const MOCK_GIT_WORKTREES = vi.hoisted(() => [
  {
    path: '/tmp/worktree-budget',
    head: 'abc',
    branch: 'main',
    isBare: false,
    isMainWorktree: false
  }
])
vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  listWorktreesStrict: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  assertWorktreeCleanForRemoval: vi.fn().mockResolvedValue(undefined),
  addWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  forceDeleteLocalBranch: vi.fn()
}))

afterEach(() => {
  vi.useRealTimers()
})

function createSlowRuntime() {
  const session = getDefaultWorkspaceSession()
  const store = {
    getRepo: () => store.getRepos()[0],
    getRepos: () => [
      { id: REPO_ID, path: REPO_PATH, displayName: 'budget', badgeColor: 'blue', addedAt: 1 }
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
  const ptyIds = Array.from({ length: ITEM_COUNT }, (_, index) => `pty-${index}`)
  runtime.setPtyController({
    spawn: async () => ({ id: 'never' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    // Every round answers just inside the controller's 3 s list timeout.
    listProcesses: () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve(ptyIds.map((id) => ({ id, cwd: WORKTREE_PATH, worktreeId: WORKTREE_ID }))),
          SLOW_LIST_MS
        )
      )
  } as never)
  const reveal = vi.fn(
    async (worktree: string, opts: { tabId?: string; leafId?: string; ptyId: string }) => ({
      tabId: opts.tabId,
      identity: { worktreeId: worktree, tabId: opts.tabId, leafId: opts.leafId, ptyId: opts.ptyId }
    })
  )
  runtime.setNotifier({ revealTerminalSession: reveal } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  ptyIds.forEach((ptyId, index) => {
    runtime.registerPty(ptyId, WORKTREE_ID, null, { tabId: `tab-${index}`, leafId: LEAF_ID })
  })
  return { runtime, reveal }
}

describe('live-surface reconcile time budget', () => {
  it('ends within the budget plus one list timeout when every liveness round is slow', async () => {
    const { runtime, reveal } = createSlowRuntime()
    // Resolve the worktree catalog on real timers; only the controller rounds are slow.
    const catalog = runtime as never as { getResolvedWorktreeMap: () => Promise<unknown> }
    const resolved = await catalog.getResolvedWorktreeMap()
    catalog.getResolvedWorktreeMap = async () => resolved

    vi.useFakeTimers()
    let settled = false
    const startedAt = Date.now()
    const done = runtime.reconcileLiveTerminalSurfacesForRenderer().then(() => {
      settled = true
    })
    while (!settled && Date.now() - startedAt < 120_000) {
      await vi.advanceTimersByTimeAsync(100)
    }
    await done
    const elapsed = Date.now() - startedAt

    // Planning inventory (one slow round) + the drain budget + at most one more list timeout.
    expect(elapsed).toBeLessThanOrEqual(SLOW_LIST_MS + LIVE_SURFACE_RECONCILE_BUDGET_MS + 3_000)
    // Without the deadline the 8 serialized rounds take 8 x 2.9 s = 23.2 s and the bound above fails.
    expect(reveal.mock.calls.length).toBeGreaterThan(0)
    expect(reveal.mock.calls.length).toBeLessThan(ITEM_COUNT)
  })
})
