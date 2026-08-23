import { describe, expect, it } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  PaneCredentialLaneRegistry,
  assertPaneAdoptableByCaller,
  laneEquals,
  parsePersistedPaneCredentialLane,
  serializePaneCredentialLane,
  type PaneCredentialLane
} from './pane-credential-lane-registry'

const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const PRINCIPAL_B = '22222222-2222-4222-8222-222222222222'
const laneA: PaneCredentialLane = { kind: 'principal', principalId: PRINCIPAL_A }
const laneB: PaneCredentialLane = { kind: 'principal', principalId: PRINCIPAL_B }
const shared: PaneCredentialLane = { kind: 'shared' }

function refusalCode(run: () => void): string {
  try {
    run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${String(error)}`
  }
  return 'no-refusal'
}

describe('PaneCredentialLaneRegistry', () => {
  it('keeps two pairs whose components differ only by a space in distinct rows', () => {
    const registry = new PaneCredentialLaneRegistry()
    // Why: worktreeIds embed filesystem paths and a client-supplied tabId only forbids ':', so a
    // space separator would alias `('repo::wt a', 'b:leaf')` onto `('repo::wt', 'a b:leaf')`.
    registry.bind('repo::wt a', 'b:leaf', laneA)
    registry.bind('repo::wt', 'a b:leaf', laneB)

    expect(registry.laneOf('repo::wt a', 'b:leaf')).toEqual(laneA)
    expect(registry.laneOf('repo::wt', 'a b:leaf')).toEqual(laneB)
    expect(registry.entries()).toEqual([
      { worktreeId: 'repo::wt a', paneKey: 'b:leaf', lane: laneA },
      { worktreeId: 'repo::wt', paneKey: 'a b:leaf', lane: laneB }
    ])
  })

  it('binds a pane once and never rewrites the row', () => {
    const registry = new PaneCredentialLaneRegistry()
    expect(registry.bind('wt1', 'tab:leaf', laneA)).toEqual(laneA)
    expect(registry.bind('wt1', 'tab:leaf', shared)).toEqual(laneA)
    expect(registry.laneOf('wt1', 'tab:leaf')).toEqual(laneA)
  })

  it('reports an unknown pane and a known-but-unbound pane differently', () => {
    const registry = new PaneCredentialLaneRegistry()
    expect(registry.lookup('wt1', 'tab:leaf', false)).toEqual({ kind: 'unknown' })
    expect(registry.lookup('wt1', 'tab:leaf', true)).toEqual({ kind: 'unbound' })
    registry.bind('wt1', 'tab:leaf', shared)
    expect(registry.lookup('wt1', 'tab:leaf', true)).toEqual({ kind: 'bound', lane: shared })
  })

  it('keys the binding by worktree as well as pane', () => {
    const registry = new PaneCredentialLaneRegistry()
    registry.bind('wt1', 'tab:leaf', laneA)
    expect(registry.laneOf('wt2', 'tab:leaf')).toBeNull()
  })

  it('round-trips a lane through the persisted binding row', () => {
    const registry = new PaneCredentialLaneRegistry()
    registry.bind('wt1', 'tab:leaf', laneA)
    registry.bind('wt1', 'tab:other', shared)
    const rows = Object.fromEntries(
      registry
        .entries()
        .map((entry) => [entry.paneKey, serializePaneCredentialLane(entry.worktreeId, entry.lane)])
    )

    const restored = new PaneCredentialLaneRegistry()
    restored.rehydrate(rows)

    expect(restored.laneOf('wt1', 'tab:leaf')).toEqual(laneA)
    expect(restored.laneOf('wt1', 'tab:other')).toEqual(shared)
  })

  it('drops a persisted row whose principal is not a validated principal id', () => {
    expect(
      parsePersistedPaneCredentialLane({ worktreeId: 'wt1', principalId: 'not-a-uuid' })
    ).toBeNull()
    expect(parsePersistedPaneCredentialLane({ worktreeId: 'wt1' })).toEqual(shared)
    expect(parsePersistedPaneCredentialLane(undefined)).toBeNull()
  })

  it('compares lanes by principal', () => {
    expect(laneEquals(laneA, { kind: 'principal', principalId: PRINCIPAL_A })).toBe(true)
    expect(laneEquals(laneA, laneB)).toBe(false)
    expect(laneEquals(laneA, shared)).toBe(false)
    expect(laneEquals(shared, shared)).toBe(true)
  })
})

describe('assertPaneAdoptableByCaller', () => {
  const registry = new PaneCredentialLaneRegistry()
  registry.bind('wt1', 'lane-a:pane', laneA)
  registry.bind('wt1', 'shared:pane', shared)

  it('refuses a lane caller adopting another lane’s pane', () => {
    expect(
      refusalCode(() =>
        assertPaneAdoptableByCaller(registry.lookup('wt1', 'lane-a:pane', true), laneB)
      )
    ).toBe('terminal.lane_not_owned')
  })

  it('refuses a lane-less shared caller adopting a lane-bound pane', () => {
    expect(
      refusalCode(() =>
        assertPaneAdoptableByCaller(registry.lookup('wt1', 'lane-a:pane', true), shared)
      )
    ).toBe('terminal.lane_not_owned')
  })

  it('refuses a lane caller adopting an explicitly shared pane', () => {
    expect(
      refusalCode(() =>
        assertPaneAdoptableByCaller(registry.lookup('wt1', 'shared:pane', true), laneA)
      )
    ).toBe('terminal.lane_not_owned')
  })

  it('refuses a lane caller materializing an unbound pane', () => {
    expect(
      refusalCode(() =>
        assertPaneAdoptableByCaller(registry.lookup('wt1', 'legacy:pane', true), laneA)
      )
    ).toBe('terminal.lane_pane_unbound')
  })

  it('leaves a lane-less caller’s unbound materialize exactly as it is today', () => {
    expect(
      refusalCode(() =>
        assertPaneAdoptableByCaller(registry.lookup('wt1', 'legacy:pane', true), shared)
      )
    ).toBe('no-refusal')
  })

  it('admits the pane’s own owner and a create that mints a fresh identity', () => {
    expect(
      refusalCode(() =>
        assertPaneAdoptableByCaller(registry.lookup('wt1', 'lane-a:pane', true), laneA)
      )
    ).toBe('no-refusal')
    expect(
      refusalCode(() =>
        assertPaneAdoptableByCaller(registry.lookup('wt1', 'fresh:pane', false), laneA)
      )
    ).toBe('no-refusal')
  })

  it('carries a complete human sentence on every refusal', () => {
    for (const [lookup, caller] of [
      [registry.lookup('wt1', 'lane-a:pane', true), laneB],
      [registry.lookup('wt1', 'legacy:pane', true), laneA]
    ] as const) {
      try {
        assertPaneAdoptableByCaller(lookup, caller)
        expect.unreachable('expected a refusal')
      } catch (error) {
        expect(isClaudeLaneRefusal(error)).toBe(true)
        expect(isClaudeLaneRefusal(error) ? error.message.length : 0).toBeGreaterThan(40)
      }
    }
  })
})
