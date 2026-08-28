import { describe, expect, it } from 'vitest'
import {
  CLAUDE_LANE_REFUSAL_CODES,
  ClaudeLaneRefusal,
  isClaudeLaneRefusal
} from './claude-lane-refusals'

// S9-L1 §3 mint list — additive only (§F forbids retiring the push/lease-era codes here).
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

  it('still holds every pre-S9-L1 code — additive only, nothing retired', () => {
    // §F: S9-L1 must not retire any of the push/lease-era codes; that is S9-L3's.
    expect(CLAUDE_LANE_REFUSAL_CODES).toContain('accounts.lane.push_write_failed')
    expect(CLAUDE_LANE_REFUSAL_CODES).toContain('accounts.lane.push_write_locked')
    expect(CLAUDE_LANE_REFUSAL_CODES).toContain('accounts.lane.clear_incomplete')
  })

  it('ClaudeLaneRefusal carries a code from the typed union', () => {
    const refusal = new ClaudeLaneRefusal('accounts.lane.login_session_unknown', 'a sentence')
    expect(isClaudeLaneRefusal(refusal)).toBe(true)
    expect(refusal.code).toBe('accounts.lane.login_session_unknown')
  })
})
