// S10-16 C6/C6a, Ruling 26 Addendum 2(z)/3(gg), Ruling 27(d): `describeReplyRelayLinkHealth`, the
// outbox-row-to-health-word mapper — reply-relay conditions (unreachable, stale pairing,
// unsupported, abandoned) derived DIRECTLY from `peer_reply_outbox` rows (state,
// consecutive_failures, last_error_code, created_at), never from the no-run notice's audit row
// (s10-16-review-C5c.md finding 3; s10-16-review-C6.md F4).
import { describe, expect, it } from 'vitest'
import { describeReplyRelayLinkHealth } from './reply-outbox-health'
import {
  REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD,
  LINK_BINDING_REVERIFY_MS
} from './link-binding-constants'

const NOW = 1_000_000_000_000

type Row = {
  state: 'queued' | 'sending' | 'abandoned' | 'delivered' | 'refused' | 'cancelled'
  consecutiveFailures: number
  lastErrorCode: string | null
  createdAt: number
}

const row = (r: Partial<Row>): Row => ({
  state: 'queued',
  consecutiveFailures: 0,
  lastErrorCode: null,
  createdAt: NOW,
  ...r
})

describe('describeReplyRelayLinkHealth', () => {
  it('no rows: null', () => {
    expect(describeReplyRelayLinkHealth([], NOW)).toBeNull()
  })

  it('a healthy queued row (below threshold, no error) contributes nothing', () => {
    expect(describeReplyRelayLinkHealth([row({ consecutiveFailures: 1 })], NOW)).toBeNull()
  })

  it('a settled delivered/refused/cancelled row never contributes', () => {
    expect(
      describeReplyRelayLinkHealth(
        [
          row({ state: 'delivered', consecutiveFailures: 99 }),
          row({ state: 'refused', lastErrorCode: 'stale_environment_pairing' }),
          row({ state: 'cancelled' })
        ],
        NOW
      )
    ).toBeNull()
  })

  it('a queued row past the unreachable failure threshold reads unreachable', () => {
    expect(
      describeReplyRelayLinkHealth(
        [row({ consecutiveFailures: REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD })],
        NOW
      )
    ).toBe('unreachable')
  })

  it('a held row naming stale_environment_pairing reads stale', () => {
    expect(
      describeReplyRelayLinkHealth([row({ lastErrorCode: 'stale_environment_pairing' })], NOW)
    ).toBe('stale')
  })

  it('a held row naming capability_unsupported reads unsupported', () => {
    expect(
      describeReplyRelayLinkHealth([row({ lastErrorCode: 'capability_unsupported' })], NOW)
    ).toBe('unsupported')
  })

  // Ruling 27(d)/F4a: runtime_environment_changed is the honest word — the peer answered, and
  // answered that its runtime environment moved. It is NOT transport-shaped `unreachable`.
  it('an abandoned row naming runtime_environment_changed reads stale, not unreachable', () => {
    expect(
      describeReplyRelayLinkHealth(
        [row({ state: 'abandoned', lastErrorCode: 'runtime_environment_changed' })],
        NOW
      )
    ).toBe('stale')
  })

  // Ruling 27(d)/F4a: an abandonment with no informative code and no failure streak is not
  // evidence of unreachability.
  it('an abandoned row with no informative last_error_code and no failure streak contributes nothing', () => {
    expect(describeReplyRelayLinkHealth([row({ state: 'abandoned' })], NOW)).toBeNull()
  })

  it('an abandoned row with no informative last_error_code but a failure streak reads unreachable', () => {
    expect(
      describeReplyRelayLinkHealth(
        [
          row({
            state: 'abandoned',
            consecutiveFailures: REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD
          })
        ],
        NOW
      )
    ).toBe('unreachable')
  })

  it('an abandoned row naming stale_environment_pairing reads stale', () => {
    expect(
      describeReplyRelayLinkHealth(
        [row({ state: 'abandoned', lastErrorCode: 'stale_environment_pairing' })],
        NOW
      )
    ).toBe('stale')
  })

  it('an abandoned row naming capability_unsupported reads unsupported', () => {
    expect(
      describeReplyRelayLinkHealth(
        [row({ state: 'abandoned', lastErrorCode: 'capability_unsupported' })],
        NOW
      )
    ).toBe('unsupported')
  })

  // Ruling 27(d)/F4b: a terminal row older than LINK_BINDING_REVERIFY_MS (from its own
  // created_at) is ignored entirely, so it can never pin a link's health above `proven` forever.
  it('an abandoned row older than LINK_BINDING_REVERIFY_MS contributes nothing, even with an informative code', () => {
    expect(
      describeReplyRelayLinkHealth(
        [
          row({
            state: 'abandoned',
            lastErrorCode: 'capability_unsupported',
            createdAt: NOW - LINK_BINDING_REVERIFY_MS - 1000
          })
        ],
        NOW
      )
    ).toBeNull()
  })

  it('an abandoned row just inside LINK_BINDING_REVERIFY_MS still contributes', () => {
    expect(
      describeReplyRelayLinkHealth(
        [
          row({
            state: 'abandoned',
            lastErrorCode: 'capability_unsupported',
            createdAt: NOW - LINK_BINDING_REVERIFY_MS + 1000
          })
        ],
        NOW
      )
    ).toBe('unsupported')
  })

  it('across many rows on one link, unreachable outranks unsupported outranks stale (A4-02 order)', () => {
    expect(
      describeReplyRelayLinkHealth(
        [
          row({ lastErrorCode: 'stale_environment_pairing' }),
          row({ lastErrorCode: 'capability_unsupported' }),
          row({ consecutiveFailures: REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD })
        ],
        NOW
      )
    ).toBe('unreachable')
    expect(
      describeReplyRelayLinkHealth(
        [
          row({ lastErrorCode: 'stale_environment_pairing' }),
          row({ lastErrorCode: 'capability_unsupported' })
        ],
        NOW
      )
    ).toBe('unsupported')
  })
})
