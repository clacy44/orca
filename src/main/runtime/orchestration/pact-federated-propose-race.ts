// S10-21b B10 (design §2.13, Ruling 34 Addendum 4 amendment 14) — the cross-propose tie-break,
// consumed by pact-federated-inbound-apply.ts's `applyPropose` only. Split out per the max-lines
// ratchet and so the comparison predicate has one, directly-testable home.
//
// Race rule (design §2.13, unchanged from v2): "the proposal whose ORIGINATING THREAD ID sorts
// LOWER (byte-wise) wins; the loser's proposal is auto-declined locally (a real `decline` ledger
// row and a relayed `decline`) in the same transaction, before the winner's `propose` is
// applied." The LOCAL host's own outstanding proposal's originating thread id is that
// proposal's own `thread.id` (what `proposePact` wrote when this host proposed); the INCOMING
// proposal's originating thread id is the sender's own thread id, relayed as `args.peerThreadId`
// (gate 7 already validated it as a host thread id before this runs). Both hosts compare the
// identical pair of ids, so the winner is symmetric — never a function of arrival order.
//
// The inbound `propose` apply is ALSO where B3's (link, display_name) pair guard
// (`requireNoEngagedPactWithPeer`, pact-shared.ts) belongs (design §2.13's opening line): before
// this commit, `applyPropose` only checked the RESOLVED thread's own column
// (`requireUnclaimedPact`), which cannot see an outstanding proposal recorded on a DIFFERENT
// thread for the same (link, display_name) peer identity — a re-registered duplicate could land
// a second active proposal on a fresh thread (T30's second assertion). Both checks live here so
// `applyPropose` has one call site.
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import { requireNoEngagedPactWithPeer, requireUnclaimedPact } from './pact-shared'
import { findRemotePartyByRenderedKey } from './pact-federated-identity'
import { enqueueFederatedPactVerb } from './pact-federated-emit'
import type { ThreadRow } from './types'
import type { ApplyInboundPactVerbArgs } from './pact-federated-inbound-gates'

export type ProposeRaceOutcome = 'fresh' | 'incoming_wins'

function peerDisplayNameFor(db: Database.Database, senderKey: string): string {
  return findRemotePartyByRenderedKey(db, senderKey)?.display_name ?? senderKey
}

// Throws (never returns) for every outcome except:
//   'fresh'         — no conflicting proposed/engaged pact anywhere for this (toAgentId,
//                      senderKey) pair; the caller applies the incoming propose as normal.
//   'incoming_wins' — a genuine simultaneous cross-propose on the SAME resolved thread, and the
//                      incoming proposal's thread id sorts lower — the caller auto-declines the
//                      local outstanding proposal, relays the decline, then applies the incoming
//                      propose, all before returning to the caller.
export function resolveCrossProposeOutcome(
  db: Database.Database,
  thread: ThreadRow,
  args: ApplyInboundPactVerbArgs,
  senderKey: string
): ProposeRaceOutcome {
  if (thread.pact_state !== null && thread.pact_state !== 'released') {
    const isSimultaneousRace =
      thread.pact_proposer_agent_id === args.toAgentId &&
      thread.pact_with_agent_id === senderKey &&
      thread.pact_state === 'proposed'
    if (isSimultaneousRace) {
      const incomingThreadId = args.peerThreadId as string
      if (thread.id > incomingThreadId) {
        // Local's own originating thread id sorts higher — local loses (design §2.13).
        return 'incoming_wins'
      }
      // Local sorts lower (equality is not reachable between two independently-minted thread
      // ids) — local wins; refuse the incoming propose the ordinary way. This IS
      // requireUnclaimedPact's existing refusal for "this thread already has a pact" — the
      // brief's own question ("may already fall out of B3's pair-guard conjunct with no new
      // code needed") is confirmed true for this branch: no new refusal path is added.
    }
    requireUnclaimedPact(thread)
    // requireUnclaimedPact always throws once pact_state is active and the race branch above
    // did not already return — unreachable, kept only so TS sees an exhaustive return.
    throw new Error('unreachable: requireUnclaimedPact did not throw')
  }
  // The resolved thread itself is unclaimed, but B3's (link, display_name) pair guard must still
  // catch an outstanding proposal recorded on a DIFFERENT thread for the same peer identity
  // (design §2.13's opening line; T30's re-registered-duplicate assertion) — requireUnclaimedPact
  // alone cannot see this, since it only reads the resolved thread's own column.
  requireNoEngagedPactWithPeer(db, args.toAgentId, senderKey, peerDisplayNameFor(db, senderKey))
  return 'fresh'
}

// Auto-decline the LOCAL outstanding proposal that just lost the tie-break, and relay the
// decline — called by `applyPropose` BEFORE era adoption, so the relay still carries the
// pre-adoption era/seq the peer's own (winning) thread already expects (gate 11 era equality).
//
// FORCED DEVIATION from the design's literal "in the same transaction" wording:
// enqueueFederatedPactVerb (B6's emit primitive, consumed not re-derived) opens its own `BEGIN
// IMMEDIATE`; SQLite does not nest transactions (the same constraint the batch-1 review flagged
// for `repointFederatedPactParty`/B13). The decline commits in its own transaction, immediately
// followed — no gate work in between — by the propose-apply transaction, not one shared one.
export function declineLosingLocalPropose(
  db: Database.Database,
  threadId: string,
  args: ApplyInboundPactVerbArgs
): void {
  const result = enqueueFederatedPactVerb(db, null, threadId, 'decline', {
    actorAgentId: args.toAgentId,
    actorPaneKey: null,
    actorHostId: null,
    runId: 'host',
    reasonCode: 'pact_cross_propose_race'
  })
  if (result.outcome === 'refused') {
    throw new OrchestrationError(
      'gate_refused',
      'The auto-decline of the losing local cross-propose was refused by the message gate.'
    )
  }
}
