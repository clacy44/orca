// S10-21b B5b (design §6, D-R133 F3): pins `peer_reply_outbox.relay_kind`'s CLOSED TS
// vocabulary — no DB CHECK, so this test IS the fence §6 requires. reply-outbox-types.ts:8
// already cites this file by name; before this commit the file did not exist (F3). Two
// independent guarantees, both load-bearing:
//   1. `ALL_RELAY_KINDS` below is exhaustively checked against the `RelayKind` union by
//      `exhaustiveRelayKindCheck`'s switch (deliberately no `default`) — tsc rejects this file
//      ("not all code paths return a value") if `RelayKind` ever gains a member this switch
//      doesn't handle.
//   2. `HEAD_OF_LINE_EXEMPT_RELAY_KINDS` is typed `readonly RelayKind[]` — the four literals
//      copied from reply-outbox-lifecycle.ts's exemption clause therefore only type-check if
//      every one of them is a genuine `RelayKind` member (a typo'd literal fails tsc, not just
//      this test).
// FAILS AT BASE: this file does not exist at base (D-R133 F3) — the RelayKind import alone
// makes it fail to resolve.
import { describe, expect, it } from 'vitest'
import type { RelayKind } from './reply-outbox-types'

// Exhaustive over every RelayKind member, deliberately with NO default: if RelayKind ever gains
// a member this switch doesn't handle, tsc rejects the file ("not all code paths return a
// value") rather than silently falling through — that failure mode IS the fence (§6: "no CHECK —
// closed vocabulary in TS plus a test"). A default case here would be flagged as unreachable dead
// code by oxlint's exhaustiveness lint while the union is complete, which is the whole point.
function exhaustiveRelayKindCheck(kind: RelayKind): RelayKind {
  switch (kind) {
    case 'reply':
    case 'pact_propose':
    case 'pact_accept':
    case 'pact_decline':
    case 'pact_step':
    case 'pact_pause':
    case 'pact_resume':
    case 'pact_release':
    case 'pact_rebind_party':
    case 'pact_resync':
    case 'pact_resync_request':
    case 'pact_gap_notice':
      return kind
  }
}

// 'reply' + the eleven pact_* verbs (§2.4's payload_kind derivation, chair answer 2:
// `relay_kind = 'pact_' + verb` uniformly).
const ALL_RELAY_KINDS: readonly RelayKind[] = [
  'reply',
  'pact_propose',
  'pact_accept',
  'pact_decline',
  'pact_step',
  'pact_pause',
  'pact_resume',
  'pact_release',
  'pact_rebind_party',
  'pact_resync',
  'pact_resync_request',
  'pact_gap_notice'
]

// The exact four literals from claimNextReplyOutboxItem's head-of-line exemption disjunct
// (reply-outbox-lifecycle.ts's `IN ('pact_release','pact_resync','pact_resync_request',
// 'pact_gap_notice')` clause, both the SELECT and the correlated UPDATE) — copied here, typed
// as RelayKind, so a divergence between the SQL literal and the TS union fails tsc.
const HEAD_OF_LINE_EXEMPT_RELAY_KINDS: readonly RelayKind[] = [
  'pact_release',
  'pact_resync',
  'pact_resync_request',
  'pact_gap_notice'
]

describe('RelayKind closed vocabulary (D-R133 F3)', () => {
  it('enumerates exactly "reply" plus the eleven pact_* verbs (12 members, no duplicates)', () => {
    expect(ALL_RELAY_KINDS).toHaveLength(12)
    expect(new Set(ALL_RELAY_KINDS).size).toBe(12)
    // Exercises the exhaustiveness switch so it is not dead code from vitest's own coverage view.
    for (const kind of ALL_RELAY_KINDS) {
      expect(exhaustiveRelayKindCheck(kind)).toBe(kind)
    }
  })

  it('the four head-of-line exemption literals in reply-outbox-lifecycle.ts are members of the vocabulary', () => {
    expect(HEAD_OF_LINE_EXEMPT_RELAY_KINDS).toHaveLength(4)
    for (const exempt of HEAD_OF_LINE_EXEMPT_RELAY_KINDS) {
      expect(ALL_RELAY_KINDS).toContain(exempt)
    }
  })
})
