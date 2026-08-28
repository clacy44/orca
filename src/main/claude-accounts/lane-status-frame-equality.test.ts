import { describe, expect, it } from 'vitest'
import type { ClaudeLaneStatus } from '../../shared/claude-lane-delegation'
import { laneStatusEqual } from './lane-status-frame-equality'

function status(overrides: Partial<ClaudeLaneStatus> = {}): ClaudeLaneStatus {
  return {
    laneId: 'lane-1',
    laneState: 'loaded',
    delegatedGrantId: null,
    callerIsDelegatedGrant: false,
    heldDisplayName: null,
    heldIdentity: null,
    refreshTokenSha256: null,
    expiresAt: null,
    ...overrides
  }
}

describe('laneStatusEqual — the accounts projection (S9-L1 §rpcs item 8)', () => {
  it('treats two content-equal accounts arrays as equal even though they are different references', () => {
    const a = status({
      accounts: [{ laneAccountId: 'id-1', email: 'a@x.com', label: null, active: true }]
    })
    const b = status({
      accounts: [{ laneAccountId: 'id-1', email: 'a@x.com', label: null, active: true }]
    })

    expect(laneStatusEqual(a, b)).toBe(true)
  })

  // MP: comparing `accounts` with the same `!==` every scalar key uses turns this red — a freshly
  // built projection array never shares a reference with the last one, even when nothing moved,
  // so every status tick would read "changed" and a subscriber would never see a stable frame.
  it('does not report changed on every tick for an unchanged accounts projection', () => {
    const rows = [{ laneAccountId: 'id-1', email: 'a@x.com', label: null, active: true }]
    const a = status({ accounts: rows.map((row) => ({ ...row })) })
    const b = status({ accounts: rows.map((row) => ({ ...row })) })

    expect(laneStatusEqual(a, b)).toBe(true)
  })

  it('reports changed when an account row flips active', () => {
    const a = status({
      accounts: [
        { laneAccountId: 'id-1', email: 'a@x.com', label: null, active: true },
        { laneAccountId: 'id-2', email: 'b@x.com', label: null, active: false }
      ]
    })
    const b = status({
      accounts: [
        { laneAccountId: 'id-1', email: 'a@x.com', label: null, active: false },
        { laneAccountId: 'id-2', email: 'b@x.com', label: null, active: true }
      ]
    })

    expect(laneStatusEqual(a, b)).toBe(false)
  })

  it('reports changed when the accounts count differs', () => {
    const a = status({
      accounts: [{ laneAccountId: 'id-1', email: 'a@x.com', label: null, active: true }]
    })
    const b = status({ accounts: [] })

    expect(laneStatusEqual(a, b)).toBe(false)
  })

  it('treats an absent accounts field as equal to itself across two old-shaped frames', () => {
    expect(laneStatusEqual(status(), status())).toBe(true)
  })
})
