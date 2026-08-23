/**
 * S9 §2d/§2k — the per-lane statusline sink and the two-feed join a terminal row reads.
 */
import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { LaneStatuslineUsageStore, pickFresherLaneUsage } from './lane-statusline-usage'

const LANE_A = '11111111-1111-4111-8111-111111111111'
const LANE_B = '22222222-2222-4222-8222-222222222222'

function window(usedPercent: number, windowMinutes: number) {
  return { usedPercent, windowMinutes, resetsAt: null, resetDescription: null }
}

function usageAt(updatedAt: number, usedPercent: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: window(usedPercent, 300),
    weekly: null,
    updatedAt,
    error: null,
    status: 'ok'
  }
}

describe('LaneStatuslineUsageStore', () => {
  it('keeps one row per lane and never mixes two lanes', () => {
    const store = new LaneStatuslineUsageStore()

    store.ingest(LANE_A, { session: window(61, 300), weekly: null, authProvenance: 'lane:a' })
    store.ingest(LANE_B, { session: window(9, 300), weekly: null, authProvenance: 'lane:b' })

    expect(store.get(LANE_A)?.session?.usedPercent).toBe(61)
    expect(store.get(LANE_B)?.session?.usedPercent).toBe(9)
  })

  it('treats an absent window as "no update", not "cleared"', () => {
    const store = new LaneStatuslineUsageStore()

    store.ingest(LANE_A, {
      session: window(61, 300),
      weekly: window(12, 10080),
      authProvenance: 'lane:a'
    })
    store.ingest(LANE_A, { session: window(70, 300), weekly: null, authProvenance: 'lane:a' })

    expect(store.get(LANE_A)?.session?.usedPercent).toBe(70)
    expect(store.get(LANE_A)?.weekly?.usedPercent).toBe(12)
  })

  it('drops a lane the tick no longer lists', () => {
    const store = new LaneStatuslineUsageStore()
    store.ingest(LANE_A, { session: window(61, 300), weekly: null, authProvenance: 'lane:a' })
    store.ingest(LANE_B, { session: window(9, 300), weekly: null, authProvenance: 'lane:b' })

    store.retainLanes([LANE_B])

    expect(store.get(LANE_A)).toBeNull()
    expect(store.get(LANE_B)).not.toBeNull()
  })

  it('forgets one lane without touching the other', () => {
    const store = new LaneStatuslineUsageStore()
    store.ingest(LANE_A, { session: window(61, 300), weekly: null, authProvenance: 'lane:a' })
    store.ingest(LANE_B, { session: window(9, 300), weekly: null, authProvenance: 'lane:b' })

    store.forget(LANE_A)

    expect(store.get(LANE_A)).toBeNull()
    expect(store.get(LANE_B)?.session?.usedPercent).toBe(9)
  })
})

describe('pickFresherLaneUsage', () => {
  it('takes the newer of the probe and the post', () => {
    expect(pickFresherLaneUsage(usageAt(100, 1), usageAt(200, 2))?.session?.usedPercent).toBe(2)
    expect(pickFresherLaneUsage(usageAt(300, 3), usageAt(200, 2))?.session?.usedPercent).toBe(3)
  })

  // The win32 arm: the probe never runs, so the post is the lane's only feed.
  it('answers from whichever feed exists alone', () => {
    expect(pickFresherLaneUsage(null, usageAt(200, 2))?.session?.usedPercent).toBe(2)
    expect(pickFresherLaneUsage(usageAt(100, 1), null)?.session?.usedPercent).toBe(1)
    expect(pickFresherLaneUsage(null, null)).toBeNull()
  })
})
