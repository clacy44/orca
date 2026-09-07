import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  mergeWorkspaceSessions,
  removeRepoFromWorkspaceSession
} from './profile-project-session-state'
import { extractSessionForTransfer } from './profile-project-session-transfer'

const REMOVED_WORKTREE_ID = 'repo-a::/removed'
const RETAINED_WORKTREE_ID = 'repo-b::/retained'
const REMOVED_REPO_ID = 'repo-a'
const RETAINED_REPO_ID = 'repo-b'

describe('profile project session state', () => {
  it('keeps topology revisions monotonic while merging session authority records', () => {
    const base = {
      ...getDefaultWorkspaceSession(),
      terminalTopologyRevisionByRepoId: { [REMOVED_REPO_ID]: 5 },
      terminalPtyIncarnationsByPaneKey: { 'base-tab:leaf': 'base-incarnation' },
      terminalLaunchTokenHashesByPaneKey: { 'base-tab:leaf': 'a'.repeat(64) },
      terminalLaunchTokenAnchorPtyByPaneKey: { 'base-tab:leaf': 'pty-base:inc-base' }
    }
    const incoming = {
      ...getDefaultWorkspaceSession(),
      terminalTopologyRevisionByRepoId: {
        [REMOVED_REPO_ID]: 3,
        [RETAINED_REPO_ID]: 7
      },
      terminalPtyIncarnationsByPaneKey: { 'incoming-tab:leaf': 'incoming-incarnation' },
      terminalLaunchTokenHashesByPaneKey: { 'incoming-tab:leaf': 'b'.repeat(64) },
      terminalLaunchTokenAnchorPtyByPaneKey: { 'incoming-tab:leaf': 'pty-incoming:inc-incoming' }
    }

    const result = mergeWorkspaceSessions(base, incoming)

    expect(result.terminalTopologyRevisionByRepoId).toEqual({
      [REMOVED_REPO_ID]: 5,
      [RETAINED_REPO_ID]: 7
    })
    expect(result.terminalPtyIncarnationsByPaneKey).toEqual({
      'base-tab:leaf': 'base-incarnation',
      'incoming-tab:leaf': 'incoming-incarnation'
    })
    // [S10-21c B1b, D-R146 LOW] The anchor binding merges beside its hash, key for key.
    expect(result.terminalLaunchTokenHashesByPaneKey).toEqual({
      'base-tab:leaf': 'a'.repeat(64),
      'incoming-tab:leaf': 'b'.repeat(64)
    })
    expect(result.terminalLaunchTokenAnchorPtyByPaneKey).toEqual({
      'base-tab:leaf': 'pty-base:inc-base',
      'incoming-tab:leaf': 'pty-incoming:inc-incoming'
    })
  })

  it('rekeys terminal membership authority during project transfer', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [REMOVED_WORKTREE_ID]: [
          {
            id: 'transferred-tab',
            worktreeId: REMOVED_WORKTREE_ID,
            title: 'Transferred',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'transferred-pty'
          }
        ]
      },
      terminalTopologyRevisionByRepoId: { [REMOVED_REPO_ID]: 6 },
      terminalPtyIncarnationsByPaneKey: {
        'transferred-tab:leaf': 'transferred-incarnation'
      },
      terminalSurfaceTombstonesByPaneKey: {
        'retired-tab:leaf': {
          worktreeId: REMOVED_WORKTREE_ID,
          parentTabId: 'retired-tab',
          leafId: 'leaf',
          ptyId: 'retired-pty',
          incarnationId: 'retired-incarnation',
          retiredAt: 1
        }
      }
    }

    const result = extractSessionForTransfer(session, 'repo-a', 'repo-c')
    const transferredWorktreeId = 'repo-c::/removed'

    expect(result.terminalTopologyRevisionByRepoId).toEqual({ 'repo-c': 6 })
    expect(result.terminalPtyIncarnationsByPaneKey).toEqual({
      'transferred-tab:leaf': 'transferred-incarnation'
    })
    expect(result.terminalSurfaceTombstonesByPaneKey?.['retired-tab:leaf']?.worktreeId).toBe(
      transferredWorktreeId
    )
  })

  it('prunes terminal membership authority records with a removed repo', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [REMOVED_WORKTREE_ID]: [
          {
            id: 'removed-tab',
            worktreeId: REMOVED_WORKTREE_ID,
            title: 'Removed',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'removed-pty'
          }
        ],
        [RETAINED_WORKTREE_ID]: [
          {
            id: 'retained-tab',
            worktreeId: RETAINED_WORKTREE_ID,
            title: 'Retained',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'retained-pty'
          }
        ]
      },
      terminalTopologyRevisionByRepoId: {
        [REMOVED_REPO_ID]: 3,
        [RETAINED_REPO_ID]: 4
      },
      terminalSurfaceTombstonesByPaneKey: {
        'removed-tab:removed-leaf': {
          worktreeId: REMOVED_WORKTREE_ID,
          parentTabId: 'removed-tab',
          leafId: 'removed-leaf',
          ptyId: 'removed-pty',
          incarnationId: 'removed-incarnation',
          retiredAt: 1
        },
        'retained-tab:retained-leaf': {
          worktreeId: RETAINED_WORKTREE_ID,
          parentTabId: 'retained-tab',
          leafId: 'retained-leaf',
          ptyId: 'retained-pty',
          incarnationId: 'retained-incarnation',
          retiredAt: 2
        }
      },
      terminalPtyIncarnationsByPaneKey: {
        'removed-tab:removed-leaf': 'removed-incarnation',
        'retained-tab:retained-leaf': 'retained-incarnation'
      },
      terminalLaunchTokenHashesByPaneKey: {
        'removed-tab:removed-leaf': 'c'.repeat(64),
        'retained-tab:retained-leaf': 'd'.repeat(64)
      },
      terminalLaunchTokenAnchorPtyByPaneKey: {
        'removed-tab:removed-leaf': 'pty-removed:inc-removed',
        'retained-tab:retained-leaf': 'pty-retained:inc-retained'
      }
    }

    const result = removeRepoFromWorkspaceSession(session, 'repo-a')

    expect(result.terminalTopologyRevisionByRepoId).toEqual({
      [RETAINED_REPO_ID]: 4
    })
    expect(result.terminalSurfaceTombstonesByPaneKey).toEqual({
      'retained-tab:retained-leaf':
        session.terminalSurfaceTombstonesByPaneKey['retained-tab:retained-leaf']
    })
    expect(result.terminalPtyIncarnationsByPaneKey).toEqual({
      'retained-tab:retained-leaf': 'retained-incarnation'
    })
    // [S10-21c B1b, D-R146 LOW] The binding is pruned in lockstep with its hash — neither
    // orphans for the removed repo's tab.
    expect(result.terminalLaunchTokenHashesByPaneKey).toEqual({
      'retained-tab:retained-leaf': 'd'.repeat(64)
    })
    expect(result.terminalLaunchTokenAnchorPtyByPaneKey).toEqual({
      'retained-tab:retained-leaf': 'pty-retained:inc-retained'
    })
  })
})
