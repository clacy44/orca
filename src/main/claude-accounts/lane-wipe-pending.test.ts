/**
 * S9 §2f — the wipe mark's own state machine, keyed per wipe because two can overlap on one lane
 * (a revoke and a last-close are fired independently from `runtime-rpc.ts`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearLaneWipePending,
  clearLaneWipePendingOnCredentialLoaded,
  isLaneWipeInFlight,
  isLaneWipePending,
  markLaneWipePending,
  releaseUnconfirmedLaneWipe,
  resetLaneWipePendingForTests
} from './lane-wipe-pending'

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'

describe('the lane wipe-pending mark', () => {
  afterEach(() => {
    resetLaneWipePendingForTests()
  })

  it('keeps the mark set when one of two wipes on the same lane finishes', () => {
    const first = markLaneWipePending(LANE_A)
    markLaneWipePending(LANE_A)

    clearLaneWipePending(LANE_A, first)

    // The second wipe is still sweeping: its fence must not be opened by the first one's read-back.
    expect(isLaneWipePending(LANE_A)).toBe(true)
    expect(isLaneWipeInFlight(LANE_A)).toBe(true)
    expect(clearLaneWipePendingOnCredentialLoaded(LANE_A)).toBe(false)
  })

  it('clears the mark once the last wipe on the lane reads back clean', () => {
    const first = markLaneWipePending(LANE_A)
    const second = markLaneWipePending(LANE_A)

    clearLaneWipePending(LANE_A, first)
    clearLaneWipePending(LANE_A, second)

    expect(isLaneWipePending(LANE_A)).toBe(false)
    expect(isLaneWipeInFlight(LANE_A)).toBe(false)
  })

  it('leaves the mark set but the sequence ended when a wipe gives up', () => {
    const sequence = markLaneWipePending(LANE_A)

    releaseUnconfirmedLaneWipe(LANE_A, sequence)

    expect(isLaneWipePending(LANE_A)).toBe(true)
    expect(isLaneWipeInFlight(LANE_A)).toBe(false)
    // A credential deliberately pushed in voids an UNCONFIRMED mark, never one still sweeping.
    expect(clearLaneWipePendingOnCredentialLoaded(LANE_A)).toBe(true)
    expect(isLaneWipePending(LANE_A)).toBe(false)
  })

  it("never touches another lane's mark", () => {
    const laneA = markLaneWipePending(LANE_A)
    markLaneWipePending(LANE_B)

    clearLaneWipePending(LANE_A, laneA)

    expect(isLaneWipePending(LANE_A)).toBe(false)
    expect(isLaneWipePending(LANE_B)).toBe(true)
  })
})
