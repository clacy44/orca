import { describe, expect, it } from 'vitest'
import { PAIRING_DEVICE_NAME_MAX_LENGTH, normalizePairingDeviceName } from './pairing-device-name'

describe('normalizePairingDeviceName', () => {
  it('keeps an ordinary name as typed', () => {
    expect(normalizePairingDeviceName('Ana Smith')).toBe('Ana Smith')
    expect(normalizePairingDeviceName("Ben's iPad")).toBe("Ben's iPad")
  })

  it('flattens control characters so a name cannot forge a readiness line', () => {
    expect(normalizePairingDeviceName('Ana\nPairing URL: orca://evil')).toBe(
      'Ana Pairing URL: orca://evil'
    )
    expect(normalizePairingDeviceName('Ana\r\n\tB')).toBe('Ana   B')
  })

  it('caps the length so one invite cannot bloat the secure registry', () => {
    const long = 'a'.repeat(PAIRING_DEVICE_NAME_MAX_LENGTH * 4)

    expect(normalizePairingDeviceName(long)).toHaveLength(PAIRING_DEVICE_NAME_MAX_LENGTH)
    // The cut must not leave trailing whitespace behind.
    expect(normalizePairingDeviceName(`${'a'.repeat(PAIRING_DEVICE_NAME_MAX_LENGTH - 1)} bc`)).toBe(
      'a'.repeat(PAIRING_DEVICE_NAME_MAX_LENGTH - 1)
    )
  })

  it('treats blank, whitespace-only and missing names alike', () => {
    // Negative control: `--pair-name "   "` must behave exactly like the desktop blank field.
    expect(normalizePairingDeviceName('   ')).toBe('')
    expect(normalizePairingDeviceName('\n\t')).toBe('')
    expect(normalizePairingDeviceName('')).toBe('')
    expect(normalizePairingDeviceName(undefined)).toBe('')
    expect(normalizePairingDeviceName(null)).toBe('')
  })
})
