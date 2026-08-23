import { describe, expect, it } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  PaneCredentialLaneRegistry,
  type PaneCredentialLane
} from './pane-credential-lane-registry'
import { resolveInheritedLane } from './terminal-inherited-lane-authority'

const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const PRINCIPAL_B = '22222222-2222-4222-8222-222222222222'
const laneA: PaneCredentialLane = { kind: 'principal', principalId: PRINCIPAL_A }
const laneB: PaneCredentialLane = { kind: 'principal', principalId: PRINCIPAL_B }
const shared: PaneCredentialLane = { kind: 'shared' }

const registry = new PaneCredentialLaneRegistry()
registry.bind('wt1', 'a:pane', laneA)
registry.bind('wt1', 'shared:pane', shared)

function refusalCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${String(error)}`
  }
  return 'no-refusal'
}

describe('resolveInheritedLane', () => {
  it('inherits the source lane for the same principal, from any of that person’s devices', () => {
    expect(
      resolveInheritedLane(registry.lookup('wt1', 'a:pane', true), {
        pairedDeviceId: 'phone-of-a',
        callerLane: { kind: 'principal', principalId: PRINCIPAL_A }
      })
    ).toEqual(laneA)
  })

  it('inherits for an anonymous local caller', () => {
    expect(
      resolveInheritedLane(registry.lookup('wt1', 'a:pane', true), { callerLane: shared })
    ).toEqual(laneA)
  })

  it('inherits a shared source for a caller that holds no lane', () => {
    expect(
      resolveInheritedLane(registry.lookup('wt1', 'shared:pane', true), {
        pairedDeviceId: 'grant-b',
        callerLane: shared
      })
    ).toEqual(shared)
  })

  it('refuses grant B inheriting grant A’s lane pane', () => {
    expect(
      refusalCode(() =>
        resolveInheritedLane(registry.lookup('wt1', 'a:pane', true), {
          pairedDeviceId: 'grant-b',
          callerLane: laneB
        })
      )
    ).toBe('terminal.lane_not_owned')
  })

  it('refuses a lane holder inheriting an explicitly shared pane', () => {
    expect(
      refusalCode(() =>
        resolveInheritedLane(registry.lookup('wt1', 'shared:pane', true), {
          pairedDeviceId: 'grant-a',
          callerLane: laneA
        })
      )
    ).toBe('terminal.lane_not_owned')
  })

  it('fails closed on a restored pane that carries no lane', () => {
    expect(
      refusalCode(() =>
        resolveInheritedLane(registry.lookup('wt1', 'legacy:pane', true), {
          pairedDeviceId: 'grant-a',
          callerLane: laneA
        })
      )
    ).toBe('terminal.lane_source_unknown')
    expect(
      refusalCode(() =>
        resolveInheritedLane(registry.lookup('wt1', 'legacy:pane', true), { callerLane: shared })
      )
    ).toBe('terminal.lane_source_unknown')
  })

  it('carries a complete human sentence on every refusal', () => {
    try {
      resolveInheritedLane(registry.lookup('wt1', 'a:pane', true), {
        pairedDeviceId: 'grant-b',
        callerLane: laneB
      })
      expect.unreachable('expected a refusal')
    } catch (error) {
      expect(isClaudeLaneRefusal(error)).toBe(true)
      expect(isClaudeLaneRefusal(error) ? error.message.length : 0).toBeGreaterThan(40)
    }
  })
})
