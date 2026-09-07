// S10-21c B2 (design §2 S8): `OrcaRuntimeService#resolveTabWorktreeId` resolves a tabId's
// owning worktree by scanning EVERY worktree bucket of the persisted session's
// `tabsByWorktree` (`Record<worktreeId, TerminalTab[]>`) — never a single-bucket lookup.
// Verified finding (S8's RETURN): a tabId is NOT guaranteed unique across worktrees at the
// type/map level — orca-runtime.ts's own admission-time collision guard
// ('terminal_orphan_surface_occupied', ~line 17925-17932) actively checks
// `Object.entries(session.tabsByWorktree).some(([ownerWorktreeId, tabs]) => ownerWorktreeId !==
// workspace.id && tabs.some((tab) => tab.id === claim.tabId))` and REFUSES a tabId claimed
// under two worktrees at once — direct evidence the invariant is runtime-enforced, not
// structurally guaranteed by the map shape. This fence mirrors that same scan.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

function storeWithSession(session: Partial<WorkspaceSessionState> | undefined) {
  return { getWorkspaceSession: vi.fn(() => session as WorkspaceSessionState | undefined) }
}

describe('OrcaRuntimeService#resolveTabWorktreeId (S10-21c B2, design S8)', () => {
  it('finds a tab id in a NON-first worktree bucket (proves it scans, not just checks bucket 0)', () => {
    const runtime = new OrcaRuntimeService(
      storeWithSession({
        tabsByWorktree: {
          'wt-a': [{ id: 'tab-a1', worktreeId: 'wt-a', title: 'x' } as never],
          'wt-b': [{ id: 'tab-b1', worktreeId: 'wt-b', title: 'y' } as never]
        }
      }) as never
    )
    expect(runtime.resolveTabWorktreeId('tab-b1')).toBe('wt-b')
    expect(runtime.resolveTabWorktreeId('tab-a1')).toBe('wt-a')
  })

  it('returns undefined for a tab id absent from every worktree bucket', () => {
    const runtime = new OrcaRuntimeService(
      storeWithSession({
        tabsByWorktree: { 'wt-a': [{ id: 'tab-a1', worktreeId: 'wt-a', title: 'x' } as never] }
      }) as never
    )
    expect(runtime.resolveTabWorktreeId('no-such-tab')).toBeUndefined()
  })

  it('returns undefined when the workspace session/store is unavailable (never assumes a match)', () => {
    const runtime = new OrcaRuntimeService(storeWithSession(undefined) as never)
    expect(runtime.resolveTabWorktreeId('tab-a1')).toBeUndefined()
  })
})
