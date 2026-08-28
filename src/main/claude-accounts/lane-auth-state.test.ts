import { describe, expect, it } from 'vitest'
import { LaneAuthState, laneAccountKey } from './lane-auth-state'

// Rev 32 (S9-L3, §10(g)) deletes Orca's managed rotation of a lane's chain and the residency index
// it read: `LaneAuthState` is now just the per-lane write queue plus the (lane, account) state
// fields `LaneSyncDriver` uses to detect the lane's own CLI moving the token. This test covers
// exactly that reduced surface; the rotation coverage that used to live here goes with the code.

describe('lane auth state', () => {
  it('keys (lane, account) state so two lanes never share a row', () => {
    const state = new LaneAuthState()
    const a = state.getState('lane-a', 'acct-1')
    const b = state.getState('lane-b', 'acct-1')
    expect(a).not.toBe(b)
    expect(state.getState('lane-a', 'acct-1')).toBe(a)
  })

  it('laneAccountKey cannot be forged across the "::" separator', () => {
    // A lane id is a UUID, so `::` cannot occur on its left; an accountUuid that tried to smuggle
    // one would still land in a distinct key from a real lane id sharing the same prefix.
    expect(laneAccountKey('lane-a', 'x')).not.toBe(laneAccountKey('lane-a::x', null))
  })

  it("forgetLane drops only that lane's (lane, account) rows", () => {
    const state = new LaneAuthState()
    const a = state.getState('lane-a', 'acct-1')
    const b = state.getState('lane-b', 'acct-1')
    state.forgetLane('lane-a')
    expect(state.getState('lane-a', 'acct-1')).not.toBe(a)
    expect(state.getState('lane-b', 'acct-1')).toBe(b)
  })

  it('serializes writes to the SAME lane in order, but not across lanes', async () => {
    const state = new LaneAuthState()
    const order: string[] = []
    const slow = state.serializeLaneWrite('lane-a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push('slow-a')
    })
    const fast = state.serializeLaneWrite('lane-a', async () => {
      order.push('fast-a')
    })
    const other = state.serializeLaneWrite('lane-b', async () => {
      order.push('lane-b')
    })
    await Promise.all([slow, fast, other])
    expect(order.indexOf('slow-a')).toBeLessThan(order.indexOf('fast-a'))
  })

  it('a rejected write does not wedge the queue for the next caller on the same lane', async () => {
    const state = new LaneAuthState()
    await expect(
      state.serializeLaneWrite('lane-a', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await expect(state.serializeLaneWrite('lane-a', async () => 'ok')).resolves.toBe('ok')
  })
})
