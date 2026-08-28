import { describe, expect, it } from 'vitest'
import {
  LANE_DISPLAY_NAME_MAX_LENGTH,
  isPrintableLaneString,
  normalizeLaneDisplayName
} from './claude-lane-delegation'

describe('lane display name bounds', () => {
  it('accepts a printable name at the ceiling and refuses one past it', () => {
    expect(normalizeLaneDisplayName('x'.repeat(LANE_DISPLAY_NAME_MAX_LENGTH))).toHaveLength(
      LANE_DISPLAY_NAME_MAX_LENGTH
    )
    expect(normalizeLaneDisplayName('x'.repeat(LANE_DISPLAY_NAME_MAX_LENGTH + 1))).toBeNull()
  })

  it('refuses every control character rather than stripping it', () => {
    for (const code of [0x00, 0x09, 0x0a, 0x1b, 0x7f]) {
      expect(isPrintableLaneString(`Work${String.fromCharCode(code)}`)).toBe(false)
      expect(normalizeLaneDisplayName(`Work${String.fromCharCode(code)}`)).toBeNull()
    }
  })

  // Negative control: the guard must not reject ordinary printable punctuation or non-ASCII.
  it('accepts printable punctuation and non-ASCII names', () => {
    expect(normalizeLaneDisplayName('Ana — work (personal)')).toBe('Ana — work (personal)')
  })

  it('refuses a non-string, an empty string and whitespace', () => {
    expect(normalizeLaneDisplayName(42)).toBeNull()
    expect(normalizeLaneDisplayName('')).toBeNull()
    expect(normalizeLaneDisplayName('   ')).toBeNull()
  })
})
