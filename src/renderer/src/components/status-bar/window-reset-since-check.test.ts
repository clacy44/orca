import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { hasWindowResetSinceCheck, withoutWindowsResetSinceCheck } from './window-reset-since-check'

const FETCHED = 1_000_000
const NOW = 2_000_000

describe('hasWindowResetSinceCheck', () => {
  it('is true when the reset passed after the data was fetched', () => {
    expect(hasWindowResetSinceCheck({ resetsAt: 1_500_000 }, FETCHED, NOW)).toBe(true)
    expect(hasWindowResetSinceCheck({ resetsAt: NOW }, FETCHED, NOW)).toBe(true)
  })

  it('is false while the reset is still ahead', () => {
    expect(hasWindowResetSinceCheck({ resetsAt: NOW + 1 }, FETCHED, NOW)).toBe(false)
  })

  it('is false when the reset predates the fetch (the numbers already reflect it)', () => {
    expect(hasWindowResetSinceCheck({ resetsAt: FETCHED }, FETCHED, NOW)).toBe(false)
    expect(hasWindowResetSinceCheck({ resetsAt: 500_000 }, FETCHED, NOW)).toBe(false)
  })

  it('is false without a usable reset time or window', () => {
    expect(hasWindowResetSinceCheck({ resetsAt: null }, FETCHED, NOW)).toBe(false)
    expect(hasWindowResetSinceCheck(null, FETCHED, NOW)).toBe(false)
    expect(hasWindowResetSinceCheck(undefined, FETCHED, NOW)).toBe(false)
    expect(hasWindowResetSinceCheck({ resetsAt: Number.NaN }, FETCHED, NOW)).toBe(false)
  })
})

describe('withoutWindowsResetSinceCheck', () => {
  const window = (resetsAt: number | null) => ({
    usedPercent: 50,
    windowMinutes: 300,
    resetsAt,
    resetDescription: null
  })
  const limits = (overrides: Partial<ProviderRateLimits>): ProviderRateLimits => ({
    provider: 'claude',
    session: window(1_500_000),
    weekly: window(NOW + 1),
    updatedAt: FETCHED,
    error: null,
    status: 'ok',
    ...overrides
  })

  it('drops only the windows that reset since the fetch', () => {
    const result = withoutWindowsResetSinceCheck(limits({}), NOW)

    expect(result.session).toBeNull()
    expect(result.weekly?.usedPercent).toBe(50)
  })

  it('drops reset buckets and optional windows too, and leaves absent ones absent', () => {
    const result = withoutWindowsResetSinceCheck(
      limits({
        fableWeekly: window(1_500_000),
        buckets: [
          { name: 'Flash', ...window(1_500_000) },
          { name: 'Pro', ...window(null) }
        ]
      }),
      NOW
    )

    expect(result.fableWeekly).toBeNull()
    expect(result.buckets?.map((bucket) => bucket.name)).toEqual(['Pro'])
    expect(result.monthly).toBeUndefined()
  })

  it('does not mutate its input', () => {
    const input = limits({})

    withoutWindowsResetSinceCheck(input, NOW)

    expect(input.session).not.toBeNull()
  })
})
