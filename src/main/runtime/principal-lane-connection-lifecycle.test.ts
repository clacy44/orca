/**
 * S9 §2f — the two connection-driven wipes, and what their results are allowed to claim.
 */
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { LaneWipeOutcome } from '../claude-accounts/principal-lane-lifecycle'
import {
  removeLaneOnGrantRevoked,
  type PrincipalLaneConnectionJoin
} from './principal-lane-connection-lifecycle'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

function join(outcome: Partial<LaneWipeOutcome>): PrincipalLaneConnectionJoin {
  const full = async (): Promise<LaneWipeOutcome> => ({
    laneId: LANE_A,
    reason: 'grant-revoked',
    removed: [],
    completed: true,
    laneRemoved: false,
    ...outcome
  })
  return {
    principalOf: (deviceId) => (deviceId === 'desktop-a' ? LANE_A : null),
    boundDeviceIds: () => [],
    connectedDeviceIds: () => [],
    removeLane: full
  }
}

// S9-L1: the connection-CLOSE wipe this suite used to cover is deleted with the login model — a
// socket closing is not a logout — so only the revoke-driven join remains here.
describe('the revoke-driven lane removal', () => {
  it('says removed only when the lane directory actually went', async () => {
    await expect(
      removeLaneOnGrantRevoked(join({ completed: true, laneRemoved: true }), LANE_A)
    ).resolves.toBe('removed')
    await expect(
      removeLaneOnGrantRevoked(join({ completed: true, laneRemoved: false }), LANE_A)
    ).resolves.toBe('not-removed-incomplete')
  })
})
