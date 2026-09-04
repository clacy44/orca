// S10-21a C4 (Ruling 34 Addendum 9): the one impure test — collectIncumbentEvidence is the only
// IO/mutable-state site this slice adds. Pattern follows agent-directory-liveness-connected-only.test.ts.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { makePaneKey } from '../../shared/stable-pane-id'

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = 'pty-agent-pane'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/probe-worktree',
        displayName: 'probe',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

function makeRuntimeWithAgentPaneLeaf(
  listProcesses: () => Promise<{ id: string; cwd: string }[]> | null
): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(listProcesses)
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      { tabId: TAB_ID, worktreeId: WORKTREE_ID, title: '', activeLeafId: LEAF_ID, layout: null }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle: null,
        title: ''
      }
    ]
  })
  return runtime
}

describe('OrcaRuntimeService.collectIncumbentEvidence', () => {
  it('reports exitObservedThisGeneration=true after a simulated onPtyExit, and ptyKnownToRuntime flips false', async () => {
    const runtime = makeRuntimeWithAgentPaneLeaf(async () => [
      { id: PTY_ID, cwd: '/tmp/probe-worktree' }
    ])

    const before = await runtime.collectIncumbentEvidence(PANE_KEY, PTY_ID, 1_000)
    expect(before.d1).toEqual({ ptyKnownToRuntime: true, exitObservedThisGeneration: false })

    runtime.onPtyExit(PTY_ID, 0)

    const after = await runtime.collectIncumbentEvidence(PANE_KEY, PTY_ID, 2_000)
    expect(after.d1).toEqual({ ptyKnownToRuntime: false, exitObservedThisGeneration: true })
  })

  it("reports d2.inventory='unknown' when the controller inventory call returns null (transient failure)", async () => {
    const runtime = makeRuntimeWithAgentPaneLeaf(async () => {
      throw new Error('transient controller failure')
    })

    const evidence = await runtime.collectIncumbentEvidence(PANE_KEY, PTY_ID, 1_000)
    expect(evidence.d2).toEqual({ inventory: 'unknown' })
  })
})
