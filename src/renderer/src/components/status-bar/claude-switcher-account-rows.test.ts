import { describe, expect, it } from 'vitest'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { buildClaudeSwitcherAccountRows } from './claude-switcher-account-rows'

const NOW = 1_700_000_000_000

function limits(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent: 10, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: NOW,
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('buildClaudeSwitcherAccountRows', () => {
  it('renders the active target with the live activeLimits snapshot', () => {
    const active = limits({ updatedAt: NOW - 5_000 })

    const rows = buildClaudeSwitcherAccountRows(
      [{ id: 'acct-active', label: 'Active account', active: true }],
      active,
      true,
      [],
      NOW
    )

    expect(rows).toEqual([
      {
        id: 'acct-active',
        label: 'Active account',
        active: true,
        limits: active,
        isFetching: false,
        ageMs: 5_000,
        emptyReason: null
      }
    ])
  })

  it('marks the active target none-yet when no activeLimits snapshot exists', () => {
    const rows = buildClaudeSwitcherAccountRows(
      [{ id: 'acct-active', label: 'Active account', active: true }],
      null,
      true,
      [],
      NOW
    )

    expect(rows).toEqual([
      {
        id: 'acct-active',
        label: 'Active account',
        active: true,
        limits: null,
        isFetching: false,
        ageMs: null,
        emptyReason: 'none-yet'
      }
    ])
  })

  it('does not borrow activeLimits for the active target when its group is not the selected group', () => {
    const active = limits()

    const rows = buildClaudeSwitcherAccountRows(
      [{ id: 'acct-active', label: 'Active account', active: true }],
      active,
      false,
      [],
      NOW
    )

    expect(rows[0]).toMatchObject({ limits: null, emptyReason: 'none-yet' })
  })

  it('reads an inactive target from the cache entry keyed by accountId', () => {
    const cached = limits({ updatedAt: NOW - 120_000 })
    const inactiveUsages: InactiveAccountUsage[] = [
      { accountId: 'acct-2', rateLimits: cached, updatedAt: NOW - 120_000, isFetching: false }
    ]

    const rows = buildClaudeSwitcherAccountRows(
      [{ id: 'acct-2', label: 'Other account', active: false }],
      null,
      true,
      inactiveUsages,
      NOW
    )

    expect(rows).toEqual([
      {
        id: 'acct-2',
        label: 'Other account',
        active: false,
        limits: cached,
        isFetching: false,
        ageMs: 120_000,
        emptyReason: null
      }
    ])
  })

  it('surfaces a fetching-but-uncached inactive target as loading, not empty', () => {
    const inactiveUsages: InactiveAccountUsage[] = [
      { accountId: 'acct-3', rateLimits: null, updatedAt: 0, isFetching: true }
    ]

    const rows = buildClaudeSwitcherAccountRows(
      [{ id: 'acct-3', label: 'Loading account', active: false }],
      null,
      true,
      inactiveUsages,
      NOW
    )

    expect(rows).toEqual([
      {
        id: 'acct-3',
        label: 'Loading account',
        active: false,
        limits: null,
        isFetching: true,
        ageMs: null,
        emptyReason: null
      }
    ])
  })

  it('marks a target with no cache entry at all as none-yet', () => {
    const rows = buildClaudeSwitcherAccountRows(
      [{ id: 'acct-4', label: 'Never fetched', active: false }],
      null,
      true,
      [],
      NOW
    )

    expect(rows).toEqual([
      {
        id: 'acct-4',
        label: 'Never fetched',
        active: false,
        limits: null,
        isFetching: false,
        ageMs: null,
        emptyReason: 'none-yet'
      }
    ])
  })

  it('maps a system (null-id) target to the "system" row id', () => {
    const rows = buildClaudeSwitcherAccountRows(
      [{ id: null, label: 'System default', active: false }],
      null,
      true,
      [],
      NOW
    )

    expect(rows[0]?.id).toBe('system')
  })
})
