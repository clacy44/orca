/**
 * Two halves of §2h's `unknown` state, which is a different thing from `shared`: a pane the host
 * knows but has never attributed, and a pane it does not know at all. The adopt gate reads both,
 * and only the second may be minted into a caller's lane (S9 §2a(ii), §2h, §3).
 */
import { describe, expect, it, vi } from 'vitest'
import { PaneLaneAuthority } from './pane-lane-authority'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { assertPaneAdoptableByCaller } from './pane-credential-lane-registry'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const WORKTREE = 'wt-1'
const TAB = '11111111-1111-4111-8111-1111111111aa'
const LEAF = '11111111-1111-4111-8111-1111111111bb'

function pendingSnapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'pending-1',
        title: 'agent',
        parentTabId: TAB,
        leafId: LEAF,
        ptyId: null,
        isActive: false
      }
    ]
  }
}

function createAuthority(options: {
  snapshot?: RuntimeMobileSessionTabsSnapshot | null
  session?: WorkspaceSessionState | null
}): PaneLaneAuthority {
  return new PaneLaneAuthority({
    rendererLeafExists: () => false,
    livePtyPaneKeys: () => [],
    workspaceSessionOf: () => options.session ?? null,
    mobileSessionTabsOf: () => options.snapshot ?? null,
    paneOfPty: () => null,
    readPersistedLanes: () => ({}),
    persistLane: vi.fn()
  })
}

function refusalOf(run: () => void): string {
  try {
    run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${String(error)}`
  }
  return 'no-refusal'
}

describe('the pane-surface probe', () => {
  it('reads a pending tab that has never spawned as a known, unattributed pane', () => {
    const authority = createAuthority({ snapshot: pendingSnapshot() })

    expect(authority.lookup(WORKTREE, TAB, LEAF)).toEqual({ kind: 'unbound' })
  })

  it('refuses a lane holder tapping that pending tab awake', () => {
    const authority = createAuthority({ snapshot: pendingSnapshot() })

    expect(
      refusalOf(() =>
        assertPaneAdoptableByCaller(authority.lookup(WORKTREE, TAB, LEAF), {
          kind: 'principal',
          principalId: PRINCIPAL_A
        })
      )
    ).toBe('terminal.lane_pane_unbound')
  })

  it('still reads a pane nothing knows as unknown, so a fresh mint is admitted', () => {
    const authority = createAuthority({ snapshot: null })

    expect(authority.lookup(WORKTREE, TAB, LEAF)).toEqual({ kind: 'unknown' })
  })
})

describe('registering a reattached pane', () => {
  it('leaves a pane restored from a pre-lane state unattributed', () => {
    const authority = createAuthority({
      session: { terminalPtyIncarnationsByPaneKey: { [`${TAB}:${LEAF}`]: 'inc-1' } } as never
    })

    authority.bindMintedPane(WORKTREE, TAB, LEAF, null, true)

    expect(authority.lookup(WORKTREE, TAB, LEAF)).toEqual({ kind: 'unbound' })
  })

  it('still states the shared lane for a pane the renderer mints', () => {
    const authority = createAuthority({})

    authority.bindMintedPane(WORKTREE, TAB, LEAF, null, false)

    expect(authority.lookup(WORKTREE, TAB, LEAF)).toEqual({
      kind: 'bound',
      lane: { kind: 'shared' }
    })
  })

  it('keeps a lane row across a reattach of the same pane', () => {
    const authority = createAuthority({})
    authority.bind(WORKTREE, TAB, LEAF, { kind: 'principal', principalId: PRINCIPAL_A })

    authority.bindMintedPane(WORKTREE, TAB, LEAF, null, true)

    expect(authority.lookup(WORKTREE, TAB, LEAF)).toEqual({
      kind: 'bound',
      lane: { kind: 'principal', principalId: PRINCIPAL_A }
    })
  })
})
