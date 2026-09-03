import { describe, expect, it } from 'vitest'
import { formatStatus, type LaneStatusSnapshot } from './lane-format'

// F-11 (Ruling 32(b)): `orca lane status` is the grant listing that renders LaneGrantSummary;
// its text output must show a live grant's accessProfile (JSON already carries it — the field is
// on the wire type, `printResult`'s JSON branch serializes the RPC result verbatim).
describe('formatStatus accessProfile (F-11)', () => {
  const baseGrant = {
    deviceId: 'dev-1',
    label: 'Desktop',
    perPerson: false,
    boundPrincipalId: null,
    designated: false,
    redeemed: true
  }

  it('renders profile:peer for a peer grant', () => {
    const snapshot: LaneStatusSnapshot = {
      grants: [{ ...baseGrant, accessProfile: 'peer' }],
      principals: []
    }
    const text = formatStatus(snapshot)
    expect(text).toContain('profile:peer')
  })

  it('renders profile:full for a full grant', () => {
    const snapshot: LaneStatusSnapshot = {
      grants: [{ ...baseGrant, deviceId: 'dev-2', accessProfile: 'full' }],
      principals: []
    }
    const text = formatStatus(snapshot)
    expect(text).toContain('profile:full')
  })
})
