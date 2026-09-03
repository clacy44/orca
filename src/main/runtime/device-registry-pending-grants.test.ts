// S10-16 R1.1: retainNewestMintedGrants partitions the eviction budget by (scope, budgetClass) — a
// deviation from device-registry.test.ts's file-not-found expectation, so this is a new file per the
// implementation plan (the plan cited a pre-existing file that does not exist at this tip).
import { describe, expect, it } from 'vitest'
import type { DeviceEntry } from './device-registry'
import { retainNewestMintedGrants } from './device-registry-pending-grants'

function minted(
  deviceId: string,
  pairedAt: number,
  overrides: Partial<DeviceEntry> = {}
): DeviceEntry {
  return {
    deviceId,
    name: deviceId,
    token: `${deviceId}-token`,
    scope: 'runtime',
    pairedAt,
    lastSeenAt: 0,
    pendingExpiresAt: pairedAt + 1,
    pendingBudgetClass: 'ui_named',
    ...overrides
  }
}

describe('retainNewestMintedGrants (S10-16 R1.1)', () => {
  it('drops the oldest pairedAt row within the (scope, budgetClass) partition once over cap', () => {
    const a = minted('a', 1)
    const b = minted('b', 2)
    const c = minted('c', 3)

    const kept = retainNewestMintedGrants([a, b, c], 2, {
      scope: 'runtime',
      budgetClass: 'ui_named'
    })

    expect(kept.map((d) => d.deviceId)).toEqual(['b', 'c'])
  })

  it('never evicts a row outside the (scope, budgetClass) partition', () => {
    // 17 serve --pair-name mints (serve_named) must never evict a lane invite, a mobile QR grant,
    // or a ui_named invite — each lives in its own partition (protocol F11).
    const laneInvite = minted('lane', 1, { pendingBudgetClass: 'lane_invite' })
    const mobileQr = minted('mobile-qr', 1, { scope: 'mobile', pendingBudgetClass: undefined })
    const uiNamed = minted('ui', 1, { pendingBudgetClass: 'ui_named' })
    const servedNamed = Array.from({ length: 17 }, (_, i) =>
      minted(`served-${i}`, i + 10, { pendingBudgetClass: 'serve_named' })
    )

    const kept = retainNewestMintedGrants([laneInvite, mobileQr, uiNamed, ...servedNamed], 16, {
      scope: 'runtime',
      budgetClass: 'serve_named'
    })

    expect(kept.some((d) => d.deviceId === 'lane')).toBe(true)
    expect(kept.some((d) => d.deviceId === 'mobile-qr')).toBe(true)
    expect(kept.some((d) => d.deviceId === 'ui')).toBe(true)
    // Exactly one of the 17 serve_named rows (the oldest by pairedAt) is dropped.
    expect(kept.filter((d) => d.pendingBudgetClass === 'serve_named')).toHaveLength(16)
    expect(kept.some((d) => d.deviceId === 'served-0')).toBe(false)
  })

  it("never evicts a row whose effective budgetClass is 'legacy' (undefined on disk)", () => {
    const legacyRows = Array.from({ length: 20 }, (_, i) =>
      minted(`legacy-${i}`, i, { pendingBudgetClass: undefined })
    )

    const kept = retainNewestMintedGrants(legacyRows, 16, {
      scope: 'runtime',
      budgetClass: 'legacy'
    })

    expect(kept).toHaveLength(20)
  })
})
