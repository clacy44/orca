import { describe, expect, it } from 'vitest'
import { parseThreadSinceCursor } from './thread-replay-since-filter'

describe('parseThreadSinceCursor', () => {
  it('parses a non-negative integer as a sequence cursor', () => {
    expect(parseThreadSinceCursor('0')).toEqual({ kind: 'sequence', value: 0 })
    expect(parseThreadSinceCursor('42')).toEqual({ kind: 'sequence', value: 42 })
  })

  // kills: reinstating a sequence-only parser that throws on an old host's/client's own
  // printed ISO created_at cursor (remote-wire-compatibility).
  it('parses an ISO timestamp as a timestamp cursor', () => {
    expect(parseThreadSinceCursor('2026-08-30T12:00:05Z')).toEqual({
      kind: 'timestamp',
      value: '2026-08-30T12:00:05Z'
    })
    expect(parseThreadSinceCursor('2026-08-30 12:00:05')).toEqual({
      kind: 'timestamp',
      value: '2026-08-30 12:00:05'
    })
  })

  it('rejects a cursor that is neither shape', () => {
    expect(() => parseThreadSinceCursor('not-a-cursor')).toThrow(/sequence number/)
    expect(() => parseThreadSinceCursor('-1')).toThrow(/sequence number/)
    expect(() => parseThreadSinceCursor('1.5')).toThrow(/sequence number/)
  })
})
