// No pre-existing test file covered formatOrchestrationSent (grep confirmed: only
// orchestration-sent-format.ts and src/cli/handlers/orchestration.ts reference it, neither a
// .test.ts) — S10-15 verifier V-6 asked to "extend its existing test"; since none exists, this
// file is created fresh rather than skipped, per the fast-worker brief's "if underspecified,
// report the deviation rather than skipping."
import { describe, expect, it } from 'vitest'
import { formatOrchestrationSent } from './orchestration-sent-format'
import type { OrchestrationSentResult } from '../shared/orchestration-delivery-state'

describe('formatOrchestrationSent', () => {
  it('reports a plain queued state with no environment line', () => {
    const result: OrchestrationSentResult = {
      delivery: { state: 'queued', recipient: { state: 'unresolved', lastSeenAt: null } }
    }
    const out = formatOrchestrationSent(result, 'msg_1', 'orca')
    expect(out).toBe(
      'msg_1: queued (recipient not currently resolvable).\n' +
        'Next step: orca orchestration sent --id msg_1 --json — check again for a state change.'
    )
    expect(out).not.toContain('environment:')
  })

  it('reports read with no next-step line and no environment line', () => {
    const result: OrchestrationSentResult = {
      delivery: { state: 'read', recipient: { state: 'unresolved', lastSeenAt: null } }
    }
    const out = formatOrchestrationSent(result, 'msg_2', 'orca')
    expect(out).toBe('msg_2: read (recipient not currently resolvable).')
    expect(out).not.toContain('environment:')
  })

  // R106 SCENARIO_CORRECTION (diag-r106-r110-2026-09-08.md): the two tests below previously
  // asserted 'msg_3: relay_pending (recipient not currently resolvable).\nenvironment:
  // env_windows_1\n...' and 'msg_4: relayed (recipient not currently resolvable).\nenvironment:
  // env_windows_1\n...'. `recipient: {state: 'unresolved'}` on a cross-host row is a hardcoded
  // placeholder, never a live predicate (no receipt exists on the wire) — "recipient not
  // currently resolvable" claimed knowledge nobody has. DEC-5/R106 replaces it with an honest
  // rendering naming what the sender actually knows; these two tests are updated to the new
  // wording rather than removed.
  it('R106: a relay_pending row renders honestly, with no resolvability claim', () => {
    const result: OrchestrationSentResult = {
      delivery: {
        state: 'relay_pending',
        recipient: { state: 'unresolved', lastSeenAt: null },
        environment: 'env_windows_1'
      }
    }
    const out = formatOrchestrationSent(result, 'msg_3', 'orca')
    expect(out).toBe(
      'msg_3: relay pending to env_windows_1; delivery state unknown.\n' +
        'Next step: orca orchestration sent --id msg_3 --json — check again for a state change.'
    )
    expect(out).not.toContain('resolvable')
  })

  it('R106: a relayed row renders honestly with the peer_relayed_at timestamp, with no resolvability claim', () => {
    const result: OrchestrationSentResult = {
      delivery: {
        state: 'relayed',
        recipient: { state: 'unresolved', lastSeenAt: null },
        environment: 'env_windows_1',
        relayedAt: '2026-09-08 12:34:56'
      }
    }
    const out = formatOrchestrationSent(result, 'msg_4', 'orca')
    expect(out).toBe(
      'msg_4: relayed to env_windows_1 at 2026-09-08 12:34:56 UTC; delivery state unknown.\n' +
        'Next step: orca orchestration sent --id msg_4 --json — check again for a state change.'
    )
    expect(out).not.toContain('resolvable')
  })

  // [S10-21d D-R162 M-3] Pre-M-3 comment said "e.g. the reply-outbox branch" — that branch now
  // carries deliveryConfirmed and renders "delivered", not this "relayed ... unknown" wording
  // (see the deliveryConfirmed cases below). This exercises a relayed row that has neither.
  it('R106: a relayed row with no relayedAt and no deliveryConfirmed omits the timestamp clause', () => {
    const result: OrchestrationSentResult = {
      delivery: {
        state: 'relayed',
        recipient: { state: 'unresolved', lastSeenAt: null },
        environment: 'env_windows_1'
      }
    }
    const out = formatOrchestrationSent(result, 'msg_4b', 'orca')
    expect(out).toBe(
      'msg_4b: relayed to env_windows_1; delivery state unknown.\n' +
        'Next step: orca orchestration sent --id msg_4b --json — check again for a state change.'
    )
  })

  // [S10-21d D-R162 M-3] The reply-outbox 'delivered' branch (orca-runtime.ts) is a real receipt
  // from the far side — a stronger claim than the plain relay mirror's peer_relayed_at — so it
  // renders "delivered", never the "relayed ... delivery state unknown" wording above.
  it('M-3: deliveryConfirmed renders "delivered" with the timestamp, no "delivery state unknown"', () => {
    const result: OrchestrationSentResult = {
      delivery: {
        state: 'relayed',
        recipient: { state: 'unresolved', lastSeenAt: null },
        environment: 'env_windows_1',
        relayedAt: '2026-09-08 12:34:56',
        deliveryConfirmed: true
      }
    }
    const out = formatOrchestrationSent(result, 'msg_4c', 'orca')
    expect(out).toBe(
      'msg_4c: delivered to env_windows_1 at 2026-09-08 12:34:56 UTC.\n' +
        'Next step: orca orchestration sent --id msg_4c --json — check again for a state change.'
    )
    expect(out).not.toContain('delivery state unknown')
  })

  it('M-3: deliveryConfirmed with no timestamp omits the "at ..." clause', () => {
    const result: OrchestrationSentResult = {
      delivery: {
        state: 'relayed',
        recipient: { state: 'unresolved', lastSeenAt: null },
        environment: 'env_windows_1',
        deliveryConfirmed: true
      }
    }
    const out = formatOrchestrationSent(result, 'msg_4d', 'orca')
    expect(out).toBe(
      'msg_4d: delivered to env_windows_1.\n' +
        'Next step: orca orchestration sent --id msg_4d --json — check again for a state change.'
    )
  })

  // S10-16 C6, plan §C6 file table: "the formatter falls back to printing the raw string rather
  // than throwing on an unknown state." Already true by construction — the ternary at
  // orchestration-sent-format.ts:13-16 has no exhaustive switch to fall through, so any state
  // this union doesn't yet name (a future outbox state on an old CLI) prints verbatim instead of
  // throwing. This test pins that property rather than asserting a code change.
  it('prints an unrecognized delivery state verbatim instead of throwing', () => {
    const result = {
      delivery: {
        state: 'some_future_state',
        recipient: { state: 'unresolved', lastSeenAt: null }
      }
    } as unknown as OrchestrationSentResult
    expect(() => formatOrchestrationSent(result, 'msg_5', 'orca')).not.toThrow()
    expect(formatOrchestrationSent(result, 'msg_5', 'orca')).toContain('some_future_state')
  })

  // [S10-21f b4, R147] 'queued_starved' — a withheld record that has crossed
  // DELIVERY_STARVATION_BOUND_MS. Renders the actual starved-minutes/attempts count rather than
  // a fixed "10m+", so it stays honest for a mailbox starved much longer than the bound.
  it('renders queued_starved with the actual starved minutes and attempt count', () => {
    const result: OrchestrationSentResult = {
      delivery: {
        state: 'queued_starved',
        recipient: { state: 'unresolved', lastSeenAt: null },
        starvedMinutes: 17,
        starvedAttempts: 4
      }
    }
    const out = formatOrchestrationSent(result, 'msg_6', 'orca')
    expect(out).toBe(
      'msg_6: queued, delivery withheld for 17m (4 attempts) — pane never reported idle ' +
        '(recipient not currently resolvable).\n' +
        'Next step: orca orchestration sent --id msg_6 --json — check again for a state change.'
    )
  })
})
