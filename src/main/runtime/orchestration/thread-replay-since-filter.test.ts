import { describe, expect, it } from 'vitest'
import { parseThreadSinceSequence } from './thread-replay-since-filter'

describe('parseThreadSinceSequence', () => {
  it('parses a non-negative integer sequence cursor', () => {
    expect(parseThreadSinceSequence('0')).toBe(0)
    expect(parseThreadSinceSequence('42')).toBe(42)
  })

  it('rejects a non-numeric cursor', () => {
    expect(() => parseThreadSinceSequence('2026-08-30T12:00:05Z')).toThrow(/sequence number/)
  })

  it('rejects a negative or fractional cursor', () => {
    expect(() => parseThreadSinceSequence('-1')).toThrow(/sequence number/)
    expect(() => parseThreadSinceSequence('1.5')).toThrow(/sequence number/)
  })
})
