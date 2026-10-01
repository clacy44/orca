// Recheck N4: only the three real CreationDate shapes parse; anything else must not cut an edge.
import { describe, expect, it } from 'vitest'
import { parseWindowsCreationDate } from './windows-foreground-process-rows'

describe('parseWindowsCreationDate', () => {
  const T = Date.UTC(2026, 9, 1, 12, 0, 0)

  it('accepts /Date(ms)/, the wmic shape and strict ISO-8601 with Z or an offset', () => {
    expect(parseWindowsCreationDate(`/Date(${T})/`)).toBe(T)
    expect(parseWindowsCreationDate('20261001120000.000000+000')).toBe(T)
    expect(parseWindowsCreationDate('20261001140000.000000+120')).toBe(T)
    expect(parseWindowsCreationDate('2026-10-01T12:00:00Z')).toBe(T)
    expect(parseWindowsCreationDate('2026-10-01T12:00:00.000Z')).toBe(T)
    expect(parseWindowsCreationDate('2026-10-01T14:00:00+02:00')).toBe(T)
  })

  it('returns undefined for "0", "", bare numbers, legacy Date forms and garbage', () => {
    for (const value of [
      '0',
      '1',
      '',
      '   ',
      'garbage',
      '2026-10-01',
      '2026-10-01T12:00:00',
      'Oct 1 2026',
      '/Date(abc)/',
      0,
      T,
      null,
      undefined,
      {}
    ]) {
      expect(parseWindowsCreationDate(value)).toBeUndefined()
    }
  })
})
