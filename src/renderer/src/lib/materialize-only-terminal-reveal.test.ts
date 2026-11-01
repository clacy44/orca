import { describe, expect, it } from 'vitest'
import {
  MATERIALIZE_ONLY_ERROR_AMBIGUOUS,
  MATERIALIZE_ONLY_ERROR_TAB_CONFLICT
} from '../../../shared/terminal-reveal-identity'
import {
  planMaterializeOnlyTerminalReveal,
  type MaterializeOnlyPlan
} from './materialize-only-terminal-reveal'

const WORKTREE = 'wt-1'
const TAB = 'tab-1'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const request = { worktreeId: WORKTREE, ptyId: 'pty-b', tabId: TAB, leafId: LEAF_B }

type PlanState = Parameters<typeof planMaterializeOnlyTerminalReveal>[0]

function makeState(overrides: {
  tab?: { ptyId?: string | null } | null
  layout?: unknown
  pending?: Record<string, string>
  tabs?: { id: string; ptyId?: string | null }[]
}): PlanState {
  const tabs =
    overrides.tabs ?? (overrides.tab === null ? [] : [{ id: TAB, ptyId: null, ...overrides.tab }])
  return {
    tabsByWorktree: { [WORKTREE]: tabs },
    terminalLayoutsByTabId: overrides.layout ? { [TAB]: overrides.layout } : {},
    ptyIdsByTabId: {},
    pendingReconnectPtyIdByTabId: overrides.pending ?? {},
    getKnownWorktreeById: () => ({ id: WORKTREE })
  } as never
}

function layoutWith(ptyIdsByLeafId: Record<string, string>): unknown {
  return {
    root: { type: 'leaf', leafId: LEAF_B },
    activeLeafId: LEAF_B,
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

function plan(state: PlanState): MaterializeOnlyPlan {
  return planMaterializeOnlyTerminalReveal(state, request)
}

const conflict = { kind: 'error', error: MATERIALIZE_ONLY_ERROR_TAB_CONFLICT }

describe('planMaterializeOnlyTerminalReveal: claiming a tab slot', () => {
  it('binds an unbound requested leaf to the pty', () => {
    expect(plan(makeState({ layout: layoutWith({}) }))).toEqual({ kind: 'bind-leaf', tabId: TAB })
  })

  it('keeps the conflict error when the leaf is bound to another pty (no rebind)', () => {
    expect(plan(makeState({ layout: layoutWith({ [LEAF_B]: 'pty-other' }) }))).toEqual(conflict)
  })

  it('keeps the conflict error when the tab records another pty at tab level', () => {
    expect(plan(makeState({ tab: { ptyId: 'pty-other' }, layout: layoutWith({}) }))).toEqual(
      conflict
    )
  })

  it('keeps the conflict error when reconnect is pending for another pty on the tab', () => {
    expect(plan(makeState({ layout: layoutWith({}), pending: { [TAB]: 'pty-other' } }))).toEqual(
      conflict
    )
  })

  it('fills a tab that has no layout', () => {
    expect(plan(makeState({}))).toEqual({ kind: 'fill-empty', tabId: TAB })
  })

  it('fills a tab whose layout has no root', () => {
    expect(plan(makeState({ layout: { root: null, ptyIdsByLeafId: {} } }))).toEqual({
      kind: 'fill-empty',
      tabId: TAB
    })
  })

  it('does not fill an empty tab that records another pty (tab level or pending)', () => {
    expect(plan(makeState({ tab: { ptyId: 'pty-other' } }))).toEqual(conflict)
    expect(plan(makeState({ pending: { [TAB]: 'pty-other' } }))).toEqual(conflict)
  })

  it('does not fill an empty tab whose layout still binds a leaf to another pty', () => {
    const layout = { root: null, ptyIdsByLeafId: { [LEAF_A]: 'pty-other' } }
    expect(plan(makeState({ layout }))).toEqual(conflict)
  })

  it('positive control: an empty layout with no other binding is filled', () => {
    expect(plan(makeState({ layout: { root: null, ptyIdsByLeafId: {} } }))).toEqual({
      kind: 'fill-empty',
      tabId: TAB
    })
  })

  it('still adds a new leaf as a split of an existing layout', () => {
    const layout = {
      root: { type: 'leaf', leafId: LEAF_A },
      activeLeafId: LEAF_A,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_A]: 'pty-a' }
    }
    expect(plan(makeState({ tab: { ptyId: 'pty-a' }, layout }))).toEqual({
      kind: 'add-leaf',
      tabId: TAB,
      sourceLeafId: LEAF_A
    })
  })

  it('positive control: with no tab at all the plan is fresh', () => {
    expect(plan(makeState({ tab: null }))).toEqual({ kind: 'fresh' })
  })
})

describe('planMaterializeOnlyTerminalReveal: ownership through the pending reconnect map', () => {
  it('treats a tab that reconnect will restore with this pty as the owner', () => {
    // Hydration nulled tab.ptyId and the layout has no binding; only the pending map names the pty.
    expect(plan(makeState({ pending: { [TAB]: 'pty-b' } }))).toEqual({ kind: 'owned', tabId: TAB })
  })

  it('carries the bound leaf identity when the owning tab layout binds the pty', () => {
    expect(
      plan(makeState({ layout: layoutWith({ [LEAF_A]: 'pty-b' }), pending: { [TAB]: 'pty-b' } }))
    ).toMatchObject({ kind: 'owned', tabId: TAB })
  })

  it('is ambiguous when two tabs both wait to restore this pty', () => {
    const state = makeState({
      tabs: [{ id: TAB }, { id: 'tab-2' }],
      pending: { [TAB]: 'pty-b', 'tab-2': 'pty-b' }
    })
    expect(plan(state)).toEqual({ kind: 'error', error: MATERIALIZE_ONLY_ERROR_AMBIGUOUS })
  })

  it('does not see a pending entry for a different pty', () => {
    expect(plan(makeState({ tab: null, pending: { [TAB]: 'pty-other' } }))).toEqual({
      kind: 'fresh'
    })
  })
})
