import { describe, expect, it } from 'vitest'
import {
  CLAUDE_LANE_REFUSAL_CODES,
  ClaudeLaneRefusal,
  isClaudeLaneRefusal
} from './claude-lane-refusals'

// S9-L1 mint list — fifteen from §3 (spec:479), plus switch_write_failed from §2m
// (spec:372, not in §3's list — see the array comment in claude-lane-refusals.ts).
// Additive only (§F forbids retiring the push/lease-era codes here).
const S9_L1_MINTED = [
  'accounts.lane.login_not_designated',
  'accounts.lane.no_login_device_designated',
  'accounts.lane.login_already_in_flight',
  'accounts.lane.login_session_unknown',
  'accounts.lane.login_session_expired',
  'accounts.lane.login_code_rejected',
  'accounts.lane.login_identity_mismatch',
  'accounts.lane.login_url_unparsed',
  'accounts.lane.login_cli_unsupported',
  'accounts.lane.login_store_full',
  'accounts.lane.login_cancelled',
  'accounts.lane.account_unknown',
  'accounts.lane.switch_in_progress',
  'accounts.lane.switch_write_locked',
  'accounts.lane.logout_incomplete',
  'accounts.lane.switch_write_failed'
] as const

describe('CLAUDE_LANE_REFUSAL_CODES — S9-L1 mint', () => {
  it('contains all sixteen S9-L1 login/account-store codes', () => {
    for (const code of S9_L1_MINTED) {
      expect(CLAUDE_LANE_REFUSAL_CODES).toContain(code)
    }
    expect(S9_L1_MINTED).toHaveLength(16)
  })

  it('has no duplicate entries', () => {
    expect(new Set(CLAUDE_LANE_REFUSAL_CODES).size).toBe(CLAUDE_LANE_REFUSAL_CODES.length)
  })

  it('S9-L3 retires the sixteen push/lease-era codes (§6, §10(g))', () => {
    const retired = [
      'accounts.lane.no_pusher_designated',
      'accounts.lane.push_stale',
      'accounts.lane.push_malformed',
      'accounts.lane.push_not_delegated',
      'accounts.lane.push_write_failed',
      'accounts.lane.push_write_locked',
      'accounts.lane.account_resident_elsewhere',
      'accounts.lane.residency_unverifiable',
      'accounts.lane.delegated_elsewhere',
      'accounts.lane.local_clear_locked',
      'accounts.lane.delegable_account_unknown',
      'accounts.lane.delegable_list_invalid',
      'accounts.lane.desktop_unavailable',
      'accounts.lane.switch_timed_out',
      'accounts.lane.switch_lane_cleared',
      'accounts.lane.clear_incomplete'
    ]
    for (const code of retired) {
      expect(CLAUDE_LANE_REFUSAL_CODES).not.toContain(code)
    }
    // The renamed successors survive: `push_write_failed`/`push_write_locked` become
    // `switch_write_failed`/`switch_write_locked`, and `clear_incomplete` becomes
    // `logout_incomplete` (§3 row 12, §2f).
    expect(CLAUDE_LANE_REFUSAL_CODES).toContain('accounts.lane.switch_write_failed')
    expect(CLAUDE_LANE_REFUSAL_CODES).toContain('accounts.lane.switch_write_locked')
    expect(CLAUDE_LANE_REFUSAL_CODES).toContain('accounts.lane.logout_incomplete')
  })

  it('ClaudeLaneRefusal carries a code from the typed union', () => {
    const refusal = new ClaudeLaneRefusal('accounts.lane.login_session_unknown', 'a sentence')
    expect(isClaudeLaneRefusal(refusal)).toBe(true)
    expect(refusal.code).toBe('accounts.lane.login_session_unknown')
  })
})
