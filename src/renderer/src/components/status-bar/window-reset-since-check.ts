import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'

/**
 * Whether a window reset after the data was fetched.
 *
 * Its percentage then describes the previous window, so callers show "reset since last check"
 * instead. A reset at or before the fetch time is already reflected in the numbers.
 */
export function hasWindowResetSinceCheck(
  window: Pick<RateLimitWindow, 'resetsAt'> | null | undefined,
  fetchedAt: number,
  now: number
): boolean {
  const resetsAt = window?.resetsAt
  return (
    typeof resetsAt === 'number' &&
    Number.isFinite(resetsAt) &&
    resetsAt <= now &&
    resetsAt > fetchedAt
  )
}

/**
 * The provider with every window that reset since the data was fetched dropped.
 *
 * Such a window's old percentage is not a number to show or to rank by; treating it as absent
 * lets the footer fall back to its no-data state when nothing current is left.
 */
export function withoutWindowsResetSinceCheck(
  p: ProviderRateLimits,
  now: number
): ProviderRateLimits {
  const keep = <T extends Pick<RateLimitWindow, 'resetsAt'> | null | undefined>(
    window: T
  ): T | null => (window && !hasWindowResetSinceCheck(window, p.updatedAt, now) ? window : null)
  return {
    ...p,
    session: keep(p.session),
    weekly: keep(p.weekly),
    fableWeekly: p.fableWeekly === undefined ? undefined : keep(p.fableWeekly),
    monthly: p.monthly === undefined ? undefined : keep(p.monthly),
    buckets: p.buckets?.filter((bucket) => !hasWindowResetSinceCheck(bucket, p.updatedAt, now))
  }
}
