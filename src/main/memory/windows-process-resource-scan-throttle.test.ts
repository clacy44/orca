// F5: the scan cache must be stamped at scan START (not completion), so real scans stay under
// the collector's CPU_STALE_AFTER_MS (10_000ms, windows-process-resource-collector.ts) even when
// a single scan takes 3-4s. Stamping at completion adds the scan duration on top of the 5s cache
// window before the next real scan can run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWindowsProcessResourceScanThrottle } from './windows-process-resource-scan-throttle'

const CPU_STALE_AFTER_MS = 10_000

describe('createWindowsProcessResourceScanThrottle scan-start stamping (F5 REPAIR)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps consecutive real scan starts under CPU_STALE_AFTER_MS with 3-4s scans polled every 2s', async () => {
    const scanStartTimestamps: number[] = []
    const scanDurationMs = 4_000
    const scan = vi.fn(() => {
      scanStartTimestamps.push(Date.now())
      return new Promise<number>((resolve) => {
        setTimeout(() => resolve(1), scanDurationMs)
      })
    })
    const run = createWindowsProcessResourceScanThrottle(scan)

    for (let elapsed = 0; elapsed <= 60_000; elapsed += 2_000) {
      void run()
      await vi.advanceTimersByTimeAsync(2_000)
    }

    expect(scanStartTimestamps.length).toBeGreaterThan(2)
    for (let index = 1; index < scanStartTimestamps.length; index += 1) {
      const gap = scanStartTimestamps[index] - scanStartTimestamps[index - 1]
      expect(gap).toBeLessThan(CPU_STALE_AFTER_MS)
    }
  })

  it('caches at the identity of the scan START time, not completion', async () => {
    const scan = vi.fn(() => new Promise<number>((resolve) => setTimeout(() => resolve(1), 4_000)))
    const run = createWindowsProcessResourceScanThrottle(scan)

    void run()
    await vi.advanceTimersByTimeAsync(4_000) // scan completes at t=4000

    // Cache window is 5000ms from scan START (t=0), so it must have already expired by t=5100.
    await vi.advanceTimersByTimeAsync(1_100) // now t=5100
    void run()
    await vi.advanceTimersByTimeAsync(0)

    expect(scan).toHaveBeenCalledTimes(2)
  })
})
