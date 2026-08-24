import { describe, expect, it } from 'vitest'
import {
  LANE_DISPLAY_NAME_MAX_LENGTH,
  MAX_LANE_DELEGABLE_ACCOUNTS,
  MAX_LANE_DELEGATION_ROWS,
  isPrintableLaneString,
  normalizeClaudeLaneDelegationRow,
  normalizeClaudeLaneDelegationRows,
  normalizeDelegableAccounts,
  normalizeLaneDisplayName
} from './claude-lane-delegation'

const delegable = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  delegatedAccountId: 'tok-1',
  clientRef: 'ref-1',
  displayName: 'Work',
  email: null,
  ...overrides
})

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

describe('delegable account normalization', () => {
  it('drops an entry with no token or no client ref, keeping the rest', () => {
    const rows = normalizeDelegableAccounts([
      delegable(),
      delegable({ delegatedAccountId: '' }),
      delegable({ delegatedAccountId: 'tok-2', clientRef: 42 }),
      delegable({ delegatedAccountId: 'tok-3', clientRef: 'ref-3' })
    ])
    expect(rows.map((row) => row.delegatedAccountId)).toEqual(['tok-1', 'tok-3'])
  })

  it('de-duplicates a repeated token so one entry cannot shadow another', () => {
    const rows = normalizeDelegableAccounts([delegable(), delegable({ displayName: 'Other' })])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.displayName).toBe('Work')
  })

  it('caps the list at the delegable ceiling', () => {
    const rows = normalizeDelegableAccounts(
      Array.from({ length: MAX_LANE_DELEGABLE_ACCOUNTS + 5 }, (_unused, index) =>
        delegable({ delegatedAccountId: `tok-${index}`, clientRef: `ref-${index}` })
      )
    )
    expect(rows).toHaveLength(MAX_LANE_DELEGABLE_ACCOUNTS)
  })

  it('nulls a control-character display name instead of dropping the whole row', () => {
    const rows = normalizeDelegableAccounts([
      delegable({ displayName: `Work${String.fromCharCode(0x07)}` })
    ])
    expect(rows[0]?.displayName).toBeNull()
    expect(rows[0]?.delegatedAccountId).toBe('tok-1')
  })
})

describe('delegation row normalization', () => {
  it('refuses a row with no lane id', () => {
    expect(normalizeClaudeLaneDelegationRow({ delegable: [] })).toBeNull()
    expect(normalizeClaudeLaneDelegationRow({ laneId: 'x'.repeat(129) })).toBeNull()
  })

  it('keeps the first row per lane and caps the table', () => {
    const rows = normalizeClaudeLaneDelegationRows([
      { laneId: 'lane-a', heldDisplayName: 'First', delegable: [] },
      { laneId: 'lane-a', heldDisplayName: 'Second', delegable: [] },
      ...Array.from({ length: MAX_LANE_DELEGATION_ROWS + 5 }, (_unused, index) => ({
        laneId: `lane-${index}`,
        delegable: []
      }))
    ])
    expect(rows).toHaveLength(MAX_LANE_DELEGATION_ROWS)
    expect(rows[0]).toEqual({ laneId: 'lane-a', heldDisplayName: 'First', delegable: [] })
  })

  it('reads a non-array table as empty rather than throwing', () => {
    expect(normalizeClaudeLaneDelegationRows({ laneId: 'lane-a' })).toEqual([])
  })
})
