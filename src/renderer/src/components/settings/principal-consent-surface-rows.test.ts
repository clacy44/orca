import { describe, expect, it } from 'vitest'
import { resolveConsentDeviceRows } from './principal-consent-surface-rows'

const ana = { principalId: 'ana-id', displayName: 'Ana', delegatedGrantId: 'ana-desktop' }
const bo = { principalId: 'bo-id', displayName: 'Bo', delegatedGrantId: null }

describe('resolveConsentDeviceRows', () => {
  it('joins a bound grant to its principal and offers designate, not bind', () => {
    const [row] = resolveConsentDeviceRows({
      grants: [{ deviceId: 'ana-desktop', name: 'Ana MBP', lastSeenAt: 10 }],
      principals: [ana],
      bindings: [{ deviceId: 'ana-desktop', principalId: 'ana-id' }]
    })
    expect(row).toEqual({
      deviceId: 'ana-desktop',
      name: 'Ana MBP',
      everConnected: true,
      boundPrincipal: { principalId: 'ana-id', displayName: 'Ana' },
      isDesignatedPusher: true,
      canBind: false,
      canDesignate: true
    })
  })

  it('offers bind, not designate, on an unbound grant', () => {
    const [row] = resolveConsentDeviceRows({
      grants: [{ deviceId: 'new-phone', name: 'Ana', lastSeenAt: 0 }],
      principals: [ana],
      bindings: []
    })
    expect(row.boundPrincipal).toBeNull()
    expect(row.canBind).toBe(true)
    expect(row.canDesignate).toBe(false)
    // §2a rule (ii): a never-connected grant is the legibility discriminator, not a gate.
    expect(row.everConnected).toBe(false)
  })

  // §2e/§2a rule (iii): a stale designation on the wrong principal must not light a row up.
  it('does not mark a device the pusher for a principal it is not bound to', () => {
    const [row] = resolveConsentDeviceRows({
      grants: [{ deviceId: 'ana-desktop', name: 'Ana MBP', lastSeenAt: 10 }],
      principals: [{ ...bo, delegatedGrantId: 'ana-desktop' }],
      bindings: [{ deviceId: 'ana-desktop', principalId: 'ana-id' }]
      // Ana's principal row is absent, so the device resolves to no known principal here.
    })
    // Bound to a principal not in the list → boundPrincipal null, and never Bo's pusher.
    expect(row.boundPrincipal).toBeNull()
    expect(row.isDesignatedPusher).toBe(false)
  })

  it('marks the designated pusher only for its own bound principal', () => {
    const rows = resolveConsentDeviceRows({
      grants: [
        { deviceId: 'ana-desktop', name: 'Ana MBP', lastSeenAt: 10 },
        { deviceId: 'ana-phone', name: 'Ana iPhone', lastSeenAt: 5 }
      ],
      principals: [ana],
      bindings: [
        { deviceId: 'ana-desktop', principalId: 'ana-id' },
        { deviceId: 'ana-phone', principalId: 'ana-id' }
      ]
    })
    expect(rows.map((row) => row.isDesignatedPusher)).toEqual([true, false])
  })
})
