import type { InactiveAccountUsage, ProviderRateLimits } from '../../../../shared/rate-limit-types'

export type ClaudeSwitcherAccountRowTarget = {
  id: string | null
  label: string
  active: boolean
}

export type ClaudeSwitcherAccountRowEmptyReason = 'none-yet'

export type ClaudeSwitcherAccountRow = {
  id: string
  label: string
  active: boolean
  limits: ProviderRateLimits | null
  isFetching: boolean
  ageMs: number | null
  emptyReason: ClaudeSwitcherAccountRowEmptyReason | null
}

// Why: mirrors usage-roster-row-state.ts — a pure row-state mapper so the
// Claude switcher's per-account body (usage bars / loading skeleton / "No
// usage yet" + age caption) is unit-testable without mounting the dropdown.
//
// The currently active account in the currently active runtime group (R146
// D1) renders `activeLimits` — the same live snapshot the collapsed badge
// already uses — instead of the inactive-account cache, because the active
// account is deliberately pruned from that cache on activation and would
// otherwise never get a row. `isActiveGroup` guards this: a fallback group
// (the caller's selected group didn't match the live runtime target) must
// not borrow `activeLimits` for a target it merely marked `active` from
// stale roster state (R146 D2's remote-pairing case can produce exactly
// this via a stale local accounts snapshot).
export function buildClaudeSwitcherAccountRows(
  targets: readonly ClaudeSwitcherAccountRowTarget[],
  activeLimits: ProviderRateLimits | null,
  isActiveGroup: boolean,
  inactiveUsages: readonly InactiveAccountUsage[],
  now: number
): ClaudeSwitcherAccountRow[] {
  return targets.map((target) => {
    const id = target.id ?? 'system'
    if (target.active && isActiveGroup) {
      return {
        id,
        label: target.label,
        active: target.active,
        limits: activeLimits,
        isFetching: false,
        ageMs: activeLimits ? Math.max(0, now - activeLimits.updatedAt) : null,
        emptyReason: activeLimits ? null : 'none-yet'
      }
    }

    const entry = target.id
      ? inactiveUsages.find((usage) => usage.accountId === target.id)
      : undefined

    if (!entry) {
      return {
        id,
        label: target.label,
        active: target.active,
        limits: null,
        isFetching: false,
        ageMs: null,
        emptyReason: 'none-yet'
      }
    }

    return {
      id,
      label: target.label,
      active: target.active,
      limits: entry.rateLimits,
      isFetching: entry.isFetching,
      ageMs: entry.rateLimits ? Math.max(0, now - entry.updatedAt) : null,
      emptyReason: entry.rateLimits || entry.isFetching ? null : 'none-yet'
    }
  })
}
