// S10-16 C6, Ruling 26 Addendum 2(z)/3(gg): `describeReplyRelayLinkHealth`, the outbox-row-to-
// health-word mapper — reply-relay conditions (unreachable, stale pairing, unsupported,
// abandoned) derived DIRECTLY from `peer_reply_outbox` rows (state, consecutive_failures,
// last_error_code), never from the no-run notice's audit row (s10-16-review-C5c.md finding 3).
import { describe, expect, it } from 'vitest'
import { describeReplyRelayLinkHealth } from './reply-outbox-health'
import { REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD } from './link-binding-constants'

type Row = {
  state: 'queued' | 'sending' | 'abandoned' | 'delivered' | 'refused' | 'cancelled'
  consecutiveFailures: number
  lastErrorCode: string | null
}

const row = (r: Partial<Row>): Row => ({
  state: 'queued',
  consecutiveFailures: 0,
  lastErrorCode: null,
  ...r
})

describe('describeReplyRelayLinkHealth', () => {
  it('no rows: null', () => {
    expect(describeReplyRelayLinkHealth([])).toBeNull()
  })

  it('a healthy queued row (below threshold, no error) contributes nothing', () => {
    expect(describeReplyRelayLinkHealth([row({ consecutiveFailures: 1 })])).toBeNull()
  })

  it('a settled delivered/refused/cancelled row never contributes', () => {
    expect(
      describeReplyRelayLinkHealth([
        row({ state: 'delivered', consecutiveFailures: 99 }),
        row({ state: 'refused', lastErrorCode: 'stale_environment_pairing' }),
        row({ state: 'cancelled' })
      ])
    ).toBeNull()
  })

  it('a queued row past the unreachable failure threshold reads unreachable', () => {
    expect(
      describeReplyRelayLinkHealth([
        row({ consecutiveFailures: REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD })
      ])
    ).toBe('unreachable')
  })

  it('a held row naming stale_environment_pairing reads stale', () => {
    expect(
      describeReplyRelayLinkHealth([row({ lastErrorCode: 'stale_environment_pairing' })])
    ).toBe('stale')
  })

  it('a held row naming capability_unsupported reads unsupported', () => {
    expect(describeReplyRelayLinkHealth([row({ lastErrorCode: 'capability_unsupported' })])).toBe(
      'unsupported'
    )
  })

  it('an abandoned row with no informative last_error_code defaults to unreachable', () => {
    expect(describeReplyRelayLinkHealth([row({ state: 'abandoned' })])).toBe('unreachable')
  })

  it('an abandoned row naming stale_environment_pairing reads stale', () => {
    expect(
      describeReplyRelayLinkHealth([
        row({ state: 'abandoned', lastErrorCode: 'stale_environment_pairing' })
      ])
    ).toBe('stale')
  })

  it('an abandoned row naming capability_unsupported reads unsupported', () => {
    expect(
      describeReplyRelayLinkHealth([
        row({ state: 'abandoned', lastErrorCode: 'capability_unsupported' })
      ])
    ).toBe('unsupported')
  })

  it('across many rows on one link, unreachable outranks unsupported outranks stale (A4-02 order)', () => {
    expect(
      describeReplyRelayLinkHealth([
        row({ lastErrorCode: 'stale_environment_pairing' }),
        row({ lastErrorCode: 'capability_unsupported' }),
        row({ consecutiveFailures: REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD })
      ])
    ).toBe('unreachable')
    expect(
      describeReplyRelayLinkHealth([
        row({ lastErrorCode: 'stale_environment_pairing' }),
        row({ lastErrorCode: 'capability_unsupported' })
      ])
    ).toBe('unsupported')
  })
})
