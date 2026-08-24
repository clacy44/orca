import { describe, expect, it } from 'vitest'
import { describeConsentAuditRow } from './principal-consent-audit-rows'

const context = {
  principals: [{ principalId: 'ana-id', displayName: 'Ana', delegatedGrantId: null }],
  grants: [{ deviceId: 'ana-desktop', name: 'Ana MBP', lastSeenAt: 10 }]
}

describe('describeConsentAuditRow', () => {
  it('resolves a bind row to its person and device with a direction', () => {
    expect(
      describeConsentAuditRow(
        {
          at: 100,
          action: 'bind',
          principalId: 'ana-id',
          deviceId: 'ana-desktop',
          direction: 'bind'
        },
        context
      )
    ).toEqual({
      at: 100,
      action: 'bind',
      principalLabel: 'Ana',
      deviceLabel: 'Ana MBP',
      direction: 'bind'
    })
  })

  // §2a rule (iii): designate carries no direction and names its subject in `designatedGrantId`.
  it('reads a designate row’s subject from the designated grant and carries no direction', () => {
    const view = describeConsentAuditRow(
      { at: 200, action: 'designate', principalId: 'ana-id', designatedGrantId: 'ana-desktop' },
      context
    )
    expect(view.deviceLabel).toBe('Ana MBP')
    expect(view).not.toHaveProperty('direction')
  })

  // The log's whole point is that deletions stay visible: a gone grant falls back to its short id.
  it('falls back to the short id when the device is gone', () => {
    expect(
      describeConsentAuditRow(
        {
          at: 300,
          action: 'unbind',
          principalId: 'ana-id',
          deviceId: 'deadbeefcafef00d',
          direction: 'unbind'
        },
        context
      ).deviceLabel
    ).toBe('deadbeef')
  })

  it('falls back to the raw id when the principal is gone', () => {
    expect(
      describeConsentAuditRow(
        { at: 400, action: 'create-principal', principalId: 'ghost-id' },
        context
      ).principalLabel
    ).toBe('ghost-id')
  })

  it('leaves the labels null when the row names neither', () => {
    const view = describeConsentAuditRow(
      { at: 500, action: 'link-bind', principalId: null, homePeerFingerprint: 'f'.repeat(64) },
      context
    )
    expect(view.principalLabel).toBeNull()
    expect(view.deviceLabel).toBeNull()
  })
})
