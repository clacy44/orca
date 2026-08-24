/**
 * S9 §2f — the two connection-driven wipes, and what their results are allowed to claim.
 */
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { LaneWipeOutcome } from '../claude-accounts/principal-lane-lifecycle'
import {
  removeLaneOnGrantRevoked,
  wipeLaneOnConnectionClose,
  type PrincipalLaneConnectionJoin
} from './principal-lane-connection-lifecycle'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

function join(outcome: Partial<LaneWipeOutcome>): PrincipalLaneConnectionJoin {
  const full = async (): Promise<LaneWipeOutcome> => ({
    laneId: LANE_A,
    reason: 'last-connection-close',
    removed: [],
    completed: true,
    laneRemoved: false,
    ...outcome
  })
  return {
    principalOf: (deviceId) => (deviceId === 'desktop-a' ? LANE_A : null),
    boundDeviceIds: () => [],
    connectedDeviceIds: () => [],
    wipeLane: full,
    removeLane: full
  }
}

describe('the connection-driven lane wipes', () => {
  it('says wiped only when the sweep read the lane back clean', async () => {
    await expect(wipeLaneOnConnectionClose(join({ completed: true }), 'desktop-a')).resolves.toBe(
      'wiped'
    )
  })

  it('does not claim a wipe the lifecycle could not confirm', async () => {
    // `completed: false` means the credential may still be on disk and the lane is latched
    // wipe-pending — the one outcome a caller must be able to tell apart.
    await expect(wipeLaneOnConnectionClose(join({ completed: false }), 'desktop-a')).resolves.toBe(
      'not-wiped-incomplete'
    )
  })

  it('says removed only when the lane directory actually went', async () => {
    await expect(
      removeLaneOnGrantRevoked(join({ completed: true, laneRemoved: true }), LANE_A)
    ).resolves.toBe('removed')
    await expect(
      removeLaneOnGrantRevoked(join({ completed: true, laneRemoved: false }), LANE_A)
    ).resolves.toBe('not-removed-incomplete')
  })

  it('leaves a lane alone while another of the principal grants is connected', async () => {
    const survivor: PrincipalLaneConnectionJoin = {
      ...join({}),
      connectedDeviceIds: () => ['phone-a'],
      principalOf: () => LANE_A,
      wipeLane: () => {
        throw new Error('the lane must not be wiped while a grant of that principal is connected')
      }
    }

    await expect(wipeLaneOnConnectionClose(survivor, 'desktop-a')).resolves.toBe(
      'not-wiped-other-connections'
    )
  })
})
