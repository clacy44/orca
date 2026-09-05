// S10-21a C7h (Ruling 34 Addendum 26): findConnectedLeafOccupant now matches on tab AND leaf
// together — a leaf id alone matched the first tab in map order across every tab that reused it.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const TAB_A = 'tab-a'
const TAB_B = 'tab-b'
const PTY_A = 'pty-tab-a'
const PTY_B = 'pty-tab-b'

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

function makeRuntimeWithSameLeafIdOnTwoTabs(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      { tabId: TAB_A, worktreeId: WORKTREE_ID, title: '', activeLeafId: LEAF_ID, layout: null },
      { tabId: TAB_B, worktreeId: WORKTREE_ID, title: '', activeLeafId: LEAF_ID, layout: null }
    ],
    leaves: [
      {
        tabId: TAB_A,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_A,
        paneTitle: null,
        title: ''
      },
      {
        tabId: TAB_B,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 2,
        ptyId: PTY_B,
        paneTitle: null,
        title: ''
      }
    ]
  })
  return runtime
}

describe('OrcaRuntimeService.findConnectedLeafOccupant', () => {
  it('returns the leaf of the requested tab when the same leafId is reused across two tabs', () => {
    const runtime = makeRuntimeWithSameLeafIdOnTwoTabs()
    expect(runtime.findConnectedLeafOccupant(LEAF_ID, TAB_A)).toEqual({
      paneKey: `${TAB_A}:${LEAF_ID}`,
      ptyId: PTY_A
    })
    expect(runtime.findConnectedLeafOccupant(LEAF_ID, TAB_B)).toEqual({
      paneKey: `${TAB_B}:${LEAF_ID}`,
      ptyId: PTY_B
    })
  })

  it('returns undefined when only the OTHER tab has the requested leafId', () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'never' })),
      write: () => true,
      kill: () => true
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        { tabId: TAB_B, worktreeId: WORKTREE_ID, title: '', activeLeafId: LEAF_ID, layout: null }
      ],
      leaves: [
        {
          tabId: TAB_B,
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 1,
          ptyId: PTY_B,
          paneTitle: null,
          title: ''
        }
      ]
    })
    expect(runtime.findConnectedLeafOccupant(LEAF_ID, TAB_A)).toBeUndefined()
  })
})
