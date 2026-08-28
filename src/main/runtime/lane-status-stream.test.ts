import { describe, expect, it } from 'vitest'
import { LaneStatusStream, type LaneStatusFrame } from './lane-status-stream'

/**
 * Revoke kills the socket and runs the subscription cleanup; UNBIND and RE-BIND do not touch it.
 * So the only thing that can revoke a stream is re-resolving the grant on every delivery.
 */

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'

function makeStream() {
  const bindings = new Map<string, string>([['desktop-a', LANE_A]])
  const stream = new LaneStatusStream({
    principalOf: (deviceId) => bindings.get(deviceId) ?? null
  })
  const frames: LaneStatusFrame[] = []
  stream.subscribe({ deviceId: 'desktop-a', principalId: LANE_A }, 'conn-a', (frame) =>
    frames.push(frame)
  )
  return { bindings, stream, frames }
}

const STATUS_FRAME: LaneStatusFrame = {
  type: 'status',
  status: {
    laneId: LANE_A,
    laneState: 'absent',
    delegatedGrantId: null,
    callerIsDelegatedGrant: false,
    heldDisplayName: null,
    heldIdentity: null,
    refreshTokenSha256: null,
    expiresAt: null
  }
}

describe('lane status stream subscriber resolution', () => {
  it('delivers to a bound grant', () => {
    const { stream, frames } = makeStream()

    expect(stream.publish(LANE_A, STATUS_FRAME)).toBe(1)
    expect(frames).toHaveLength(1)
  })

  it('stops delivering once the grant is unbound', () => {
    const { bindings, stream, frames } = makeStream()
    bindings.delete('desktop-a')

    expect(stream.publish(LANE_A, STATUS_FRAME)).toBe(0)
    expect(frames).toHaveLength(0)
    expect(
      stream.callerOf({ subscriptionId: 'x', deviceId: 'desktop-a', emit: () => {} })
    ).toBeNull()
  })

  it('never delivers the old principal’s frames after a re-bind', () => {
    const { bindings, stream, frames } = makeStream()
    bindings.set('desktop-a', LANE_B)

    expect(stream.publish(LANE_A, STATUS_FRAME)).toBe(0)
    expect(frames).toHaveLength(0)
    // Positive control: it is now the OTHER principal's subscriber, not a dead one.
    expect(stream.publish(LANE_B, STATUS_FRAME)).toBe(1)
  })
})
