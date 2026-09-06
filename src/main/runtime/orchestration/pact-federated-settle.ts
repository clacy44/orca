// S10-21b B7 (design §2.8, Ruling 34 Addendum 6(4)) — the federated settle path: one guarded
// transaction closing N8's two limbs (the unimplementable v2 guard, and the unchecked
// settleReplyOutboxItem boolean). Split into its own module (not folded into
// reply-outbox-pump-deliver.ts, which stays the dispatch point) per this repo's max-lines
// ratchet precedent. The mail branch of settleReplyOutboxDelivery is UNCHANGED and untouched —
// this module owns only the pact branch (`item.pactThreadId != null`).
//
// The six numbered steps (design §2.8), inside ONE `BEGIN IMMEDIATE`:
//   1. re-read (id, pact_era, pact_state, pact_flight_token) against the outbox row's own
//      stamped values. A mismatch (a release, a re-propose, or any other flight-token-bumping
//      change landed between emit and settle) is a no-op on the PACT half (steps 3/4 below are
//      skipped) — trg_pact_turn_membership only fires when NEW.pact_state = 'engaged', so it
//      cannot by itself catch a late settle landing on a released or re-proposed pact (N8's
//      first limb) — audited `settle_stale`, and the outbox row STILL settles delivered (step 5
//      still runs regardless of staleness).
//   2. markPeerRelayAccepted — message bookkeeping, orthogonal to the pact guard above; runs
//      unconditionally, same as it always has for the mail path.
//   5. settleReplyOutboxItem(delivered) — run and its boolean CHECKED before step 3 ever
//      executes (ordering is load-bearing, not merely "before the function returns"): `false`
//      means a concurrent cancel (e.g. resetMessages mid-flight) won the race — the whole
//      settle rolls back (nothing from this call lands, including step 2's write) and is
//      audited `settle_raced`, written AFTER the rollback completes so the audit row itself is
//      not undone by it (N8's second limb).
//   3/4. (fresh path only) clear pact_turn_in_flight_at, set pact_turn_agent_id =
//      item.pactTurnAfter, and stamp the matching pact_steps ledger row
//      relay_state='delivered'/relay_settled_at (a no-op match for the three no-ledger verbs,
//      §2.5, which never had a pact_steps row to begin with).
//   6. (the caller's job, OUTSIDE this transaction) wakeTurnArrived for a LOCAL new turn holder
//      — see SettleFederatedPactDeliveryResult.turnHolderAgentId below, already filtered to
//      exclude a rendered remote party key (`remote:<link>:<id>` names the peer, never a local
//      waiter).
import type Database from '../../sqlite/sync-database'
import { writeAgentAudit } from './agent-audit-log'
import { markPeerRelayAccepted, settleReplyOutboxItem } from './reply-outbox-lifecycle'
import type { ReplyOutboxRow } from './reply-outbox-store'

export type SettleFederatedPactDeliveryParams = {
  peerMessageId: string | null
  peerReplyThreadId: string | null
}

export type SettleFederatedPactDeliveryResult =
  // Fresh settle: the pact half applied. `turnHolderAgentId` is the LOCAL agent the turn moved
  // to — null when the deferred effect handed the turn to the peer (the ordinary case for this
  // host's own outbound `step`) or when the verb carried no turn transfer at all.
  | { outcome: 'settled'; turnHolderAgentId: string | null }
  // N8 limb 1: the re-read found a different (era, state, flight token) — the pact half never
  // ran; the outbox row still settled delivered.
  | { outcome: 'stale' }
  // N8 limb 2: settleReplyOutboxItem's guarded write lost the race (a concurrent cancel) — the
  // whole settle rolled back, nothing landed.
  | { outcome: 'raced' }

type ThreadPactSnapshot = {
  pact_era: number
  pact_state: string | null
  pact_flight_token: number
  pact_peer_thread_id: string | null
}

// Internal control-flow signal only — never escapes this module. Lets the single catch block
// own the one ROLLBACK call (avoiding a second ROLLBACK-with-no-active-transaction call if the
// settle_raced audit write itself were ever attempted inside the already-rolled-back txn).
class SettleRacedSignal extends Error {}

export function settleFederatedPactDelivery(
  db: Database.Database,
  item: ReplyOutboxRow,
  params: SettleFederatedPactDeliveryParams
): SettleFederatedPactDeliveryResult {
  if (item.pactThreadId === null) {
    throw new Error(
      `internal error: settleFederatedPactDelivery called for non-pact outbox item ${item.id}`
    )
  }
  const pactThreadId = item.pactThreadId

  db.exec('BEGIN IMMEDIATE')
  try {
    // Step 1: the guard re-read.
    const threadRow = db
      .prepare(
        'SELECT pact_era, pact_state, pact_flight_token, pact_peer_thread_id FROM threads WHERE id = ?'
      )
      .get(pactThreadId) as ThreadPactSnapshot | undefined
    const stale =
      !threadRow ||
      threadRow.pact_era !== item.pactEra ||
      threadRow.pact_state !== item.pactState ||
      threadRow.pact_flight_token !== item.pactFlightToken
    const currentPeerThreadId = threadRow ? threadRow.pact_peer_thread_id : null

    // Step 2.
    markPeerRelayAccepted(db, item.localMessageId, params.peerReplyThreadId)

    // Step 5 — run and CHECK the boolean before step 3 ever runs, so a `false` return is known
    // before any deferred effect could commit.
    const settled = settleReplyOutboxItem(db, item.id, {
      state: 'delivered',
      settledAt: Date.now(),
      consecutiveFailures: 0,
      nextAttemptAfter: null,
      lastErrorCode: null,
      lastError: null,
      peerMessageId: params.peerMessageId,
      peerReplyThreadId: params.peerReplyThreadId
    })
    if (!settled) {
      throw new SettleRacedSignal()
    }

    if (stale) {
      // N1: release the in-flight marker THIS item set, or it strands forever — nothing else
      // ever clears it (delivered items never reach a terminal settle), and B8c's pact_settling
      // gate then refuses every subsequent inbound step/accept, deadlocking both sides.
      if (item.pactTurnAfter !== null) {
        db.prepare(
          `UPDATE threads SET pact_turn_in_flight_at = NULL WHERE id = ? AND pact_turn_in_flight_at IS NOT NULL`
        ).run(pactThreadId)
      }
      writeAgentAudit(db, {
        agentId: null,
        actorPaneKey: null,
        actorHostId: item.linkDeviceId,
        verb: 'replyRelay',
        outcome: 'settle_stale',
        reasonCode: JSON.stringify({ outboxId: item.id, pactThreadId })
      })
      db.exec('COMMIT')
      return { outcome: 'stale' }
    }

    // S10-21b B7c (defect 21b-D2): the fresh path only — stamp the peer's reply thread id onto
    // the ORIGINATING side's own pact_peer_thread_id the first time a settle sees one, so a
    // later inbound accept/step/release can resolve via gate 10. Never overwrites a non-null
    // value; a disagreeing non-null value is audited (settle_peer_thread_mismatch), not applied.
    if (params.peerReplyThreadId !== null) {
      if (currentPeerThreadId === null) {
        db.prepare(`UPDATE threads SET pact_peer_thread_id = ? WHERE id = ?`).run(
          params.peerReplyThreadId,
          pactThreadId
        )
      } else if (currentPeerThreadId !== params.peerReplyThreadId) {
        writeAgentAudit(db, {
          agentId: null,
          actorPaneKey: null,
          actorHostId: item.linkDeviceId,
          verb: 'replyRelay',
          outcome: 'settle_peer_thread_mismatch',
          reasonCode: JSON.stringify({
            outboxId: item.id,
            pactThreadId,
            existing: currentPeerThreadId,
            incoming: params.peerReplyThreadId
          })
        })
      }
    }

    // Steps 3/4 — the fresh path only. The marker clears UNCONDITIONALLY (closing B-16 properly
    // — never only when item.pactTurnAfter !== null); the turn-holder write stays scoped to the
    // verbs that actually carry one.
    let turnHolderAgentId: string | null = null
    if (item.pactTurnAfter !== null) {
      // D-R134 F4 local half: the settle's own turn flip bumps pact_flight_token too, so a
      // LATER settle's stale-guard re-read (step 1, above) can see this one landed.
      db.prepare(
        `UPDATE threads SET pact_turn_in_flight_at = NULL, pact_turn_agent_id = ?,
           pact_flight_token = pact_flight_token + 1 WHERE id = ?`
      ).run(item.pactTurnAfter, pactThreadId)
      turnHolderAgentId = item.pactTurnAfter.startsWith('remote:') ? null : item.pactTurnAfter
    } else {
      db.prepare(`UPDATE threads SET pact_turn_in_flight_at = NULL WHERE id = ?`).run(pactThreadId)
    }
    db.prepare(
      `UPDATE pact_steps SET relay_state = 'delivered', relay_settled_at = datetime('now')
        WHERE thread_id = ? AND message_id = ?`
    ).run(pactThreadId, item.localMessageId)

    db.exec('COMMIT')
    return { outcome: 'settled', turnHolderAgentId }
  } catch (err) {
    db.exec('ROLLBACK')
    if (err instanceof SettleRacedSignal) {
      // Written AFTER the rollback completes (a separate, auto-committing statement) — inside
      // the rolled-back transaction this row would vanish along with everything it undoes.
      writeAgentAudit(db, {
        agentId: null,
        actorPaneKey: null,
        actorHostId: item.linkDeviceId,
        verb: 'replyRelay',
        outcome: 'settle_raced',
        reasonCode: JSON.stringify({ outboxId: item.id, pactThreadId })
      })
      return { outcome: 'raced' }
    }
    throw err
  }
}
