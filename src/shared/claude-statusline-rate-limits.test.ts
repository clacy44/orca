import { describe, expect, it } from 'vitest'
import { parseClaudeStatusLineBody } from './claude-statusline-rate-limits'

function formBody(payload: unknown, configDir?: string, paneKey?: string): Record<string, string> {
  return {
    payload: JSON.stringify(payload),
    ...(configDir !== undefined ? { configDir } : {}),
    ...(paneKey !== undefined ? { paneKey } : {})
  }
}

describe('parseClaudeStatusLineBody', () => {
  it('extracts both windows and the session config dir', () => {
    const parsed = parseClaudeStatusLineBody(
      formBody(
        {
          rate_limits: {
            five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
            seven_day: { used_percentage: 41.2, resets_at: 1712059200 }
          }
        },
        '/home/dev/.config/managed-claude'
      )
    )
    expect(parsed).toEqual({
      paneKey: null,
      configDir: '/home/dev/.config/managed-claude',
      fiveHour: { used_percentage: 23.5, resets_at: 1738425600 },
      sevenDay: { used_percentage: 41.2, resets_at: 1712059200 }
    })
  })

  it('treats a missing/empty configDir as a system-default session', () => {
    const parsed = parseClaudeStatusLineBody(
      formBody({ rate_limits: { five_hour: { used_percentage: 5 } } }, '')
    )
    expect(parsed?.configDir).toBeNull()
    expect(parsed?.fiveHour).toEqual({ used_percentage: 5, resets_at: undefined })
    expect(parsed?.sevenDay).toBeNull()
  })

  it('passes through a string resets_at so schema drift degrades gracefully', () => {
    const parsed = parseClaudeStatusLineBody(
      formBody({
        rate_limits: {
          five_hour: { used_percentage: 12, resets_at: '2026-07-20T10:00:00Z' },
          seven_day: { used_percentage: 3, resets_at: '   ' }
        }
      })
    )
    expect(parsed?.fiveHour).toEqual({ used_percentage: 12, resets_at: '2026-07-20T10:00:00Z' })
    expect(parsed?.sevenDay).toEqual({ used_percentage: 3, resets_at: undefined })
  })

  it('falls back to the OAuth-shaped utilization field so schema drift degrades gracefully', () => {
    const parsed = parseClaudeStatusLineBody(
      formBody({
        rate_limits: {
          five_hour: { utilization: 37, resets_at: 1_750_000_000 },
          seven_day: { used_percentage: 8, utilization: 99 }
        }
      })
    )
    expect(parsed?.fiveHour).toEqual({ utilization: 37, resets_at: 1_750_000_000 })
    // used_percentage wins when both are present — it is the documented statusline field.
    expect(parsed?.sevenDay).toEqual({ used_percentage: 8, resets_at: undefined })
  })

  it('returns null when rate_limits is absent or empty', () => {
    expect(
      parseClaudeStatusLineBody(formBody({ context_window: { used_percentage: 8 } }))
    ).toBeNull()
    expect(parseClaudeStatusLineBody(formBody({ rate_limits: {} }))).toBeNull()
    expect(parseClaudeStatusLineBody(formBody({ rate_limits: null }))).toBeNull()
  })

  it('rejects malformed bodies without throwing', () => {
    expect(parseClaudeStatusLineBody(null)).toBeNull()
    expect(parseClaudeStatusLineBody('raw string')).toBeNull()
    expect(parseClaudeStatusLineBody({ payload: 'not json' })).toBeNull()
    expect(parseClaudeStatusLineBody({ payload: '"just a string"' })).toBeNull()
    expect(
      parseClaudeStatusLineBody(
        formBody({ rate_limits: { five_hour: { used_percentage: 'NaN' } } })
      )
    ).toBeNull()
  })

  // [S10-21d R118, design (b)] model/effort surface even with no rate_limits at all — the
  // gate this parse used to have (`rate_limits` required) is exactly the bug: a payload posted
  // purely for prefs capture must not be dropped for lacking usage windows.
  describe('S10-21d R118: model/effort capture', () => {
    it('surfaces model and effort alongside rate limits', () => {
      const parsed = parseClaudeStatusLineBody(
        formBody({
          rate_limits: { five_hour: { used_percentage: 1 } },
          model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
          effort: { level: 'xhigh' }
        })
      )
      expect(parsed?.model).toEqual({ id: 'claude-opus-4-8', displayName: 'Opus 4.8' })
      expect(parsed?.effort).toEqual({ level: 'xhigh' })
    })

    it('surfaces model/effort with NO rate_limits at all (would have returned null before this slice)', () => {
      const parsed = parseClaudeStatusLineBody(
        formBody({ model: { id: 'claude-sonnet-5' }, effort: { level: 'medium' } })
      )
      expect(parsed).not.toBeNull()
      expect(parsed?.fiveHour).toBeNull()
      expect(parsed?.sevenDay).toBeNull()
      // display_name absent -> falls back to id.
      expect(parsed?.model).toEqual({ id: 'claude-sonnet-5', displayName: 'claude-sonnet-5' })
      expect(parsed?.effort).toEqual({ level: 'medium' })
    })

    it('omits model/effort entirely when absent — existing rate-limit-only callers see no new keys', () => {
      const parsed = parseClaudeStatusLineBody(
        formBody({ rate_limits: { five_hour: { used_percentage: 1 } } })
      )
      expect(parsed).toEqual({
        paneKey: null,
        configDir: null,
        fiveHour: { used_percentage: 1, resets_at: undefined },
        sevenDay: null
      })
      expect('model' in (parsed ?? {})).toBe(false)
      expect('effort' in (parsed ?? {})).toBe(false)
    })

    it('still returns null when payload has none of rate_limits/model/effort', () => {
      expect(parseClaudeStatusLineBody(formBody({ model: {} }))).toBeNull()
      expect(parseClaudeStatusLineBody(formBody({ effort: { level: '' } }))).toBeNull()
      expect(parseClaudeStatusLineBody(formBody({ model: { id: '' } }))).toBeNull()
    })
  })

  describe("the posted paneKey — S9 §2k's attribution key", () => {
    const windows = { rate_limits: { five_hour: { used_percentage: 4 } } }

    const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

    it('keeps a paneKey the pane addresser can parse', () => {
      expect(parseClaudeStatusLineBody(formBody(windows, '/lane', PANE_KEY))?.paneKey).toBe(
        PANE_KEY
      )
    })

    // Negative control: an unparseable or oversized key must not reach the pane→lane join, or a
    // post could be attributed by a string no binding row can answer for.
    it('drops a paneKey that is not a pane key', () => {
      for (const posted of [
        '',
        '   ',
        'no-colon',
        `a:b:${PANE_KEY}`,
        `:${PANE_KEY.slice(6)}`,
        'tab-1:',
        'tab-1:not-a-uuid',
        'x'.repeat(400)
      ]) {
        expect(parseClaudeStatusLineBody(formBody(windows, '/lane', posted))?.paneKey).toBeNull()
      }
      expect(parseClaudeStatusLineBody(formBody(windows, '/lane'))?.paneKey).toBeNull()
    })
  })
})
