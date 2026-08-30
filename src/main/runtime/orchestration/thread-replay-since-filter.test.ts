import { describe, expect, it } from 'vitest'
import { normalizeThreadSinceTimestamp } from './thread-replay-since-filter'

describe('normalizeThreadSinceTimestamp', () => {
  it('converts an ISO-with-Z timestamp to the stored space-format shape', () => {
    expect(normalizeThreadSinceTimestamp('2026-08-30T12:00:05Z')).toBe('2026-08-30 12:00:05')
  })

  it('drops sub-second precision to match the stored whole-second column', () => {
    expect(normalizeThreadSinceTimestamp('2026-08-30T12:00:05.123Z')).toBe('2026-08-30 12:00:05')
  })

  it('passes an already-space-format timestamp through unchanged', () => {
    expect(normalizeThreadSinceTimestamp('2026-08-30 12:00:05')).toBe('2026-08-30 12:00:05')
  })
})
