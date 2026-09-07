// S10-21b B8/B9/B13 (design §2.5) — inbound pact-verb APPLY: gate 14's strict fence (exact
// successor / gap / desync, §2.5's full table — B9), per-verb effect, wake descriptor.
// resync_request/resync/rebind_party all bypass gate 14 entirely and dispatch straight to their
// own apply module (resync/resync_request: pact-federated-resync-apply.ts, B9; rebind_party:
// pact-federated-rebind.ts, B13 — its own six-clause gate, not the seq fence, is its idempotency
// story). gap_notice gets NO special case here — it is processed exactly as a gap of the shape
// its seq implies, through the same fence every other verb uses. Gates 6-13 live in
// pact-federated-inbound-gates.ts (max-lines split); gate 6 runs in the RPC handler.
// `pact_ordinal` NEVER comes from the wire (INV-P-021).
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import { auditPact, insertPactStepRow } from './pact-shared'
import type { ThreadRow } from './types'
import { autoPauseThreadForLedgerCap } from './pact-federated-ledger-cap-pause'
import {
  LEDGER_VERB_KIND,
  NO_LEDGER_VERBS,
  otherLocalParty,
  renderedSenderKey,
  runPactGrammarGate,
  resolvePactThread,
  runPactPartyAndMatrixGates,
  PACT_STEPS_PER_PACT_CAP,
  type ApplyInboundPactVerbArgs
} from './pact-federated-inbound-gates'
import {
  recordPactAppliedId,
  runPactStepsDedupeGate,
  runPactAppliedIdsDedupeGate
} from './pact-federated-inbound-dedupe'
import { describeWake } from './pact-federated-inbound-wake'
import {
  firePactDesyncDispositionInbound,
  mintResyncRequestIfNeeded,
  resolvePactFenceOutcome
} from './pact-federated-repair'
import {
  applyInboundResyncRequestVerb,
  applyInboundResyncVerb
} from './pact-federated-resync-apply'
import { applyInboundRebindPartyVerb, type SupersessionChainWalker } from './pact-federated-rebind'
import { applyPropose, type ApplyInboundPactVerbResult } from './pact-federated-propose-apply'
import { insertGatedMessage } from './message-gate-writer'
import { bumpThreadOnMessage } from './thread-directory'

export type {
  ApplyInboundPactVerbArgs,
  InboundPactEnvelope,
  InboundPactVerb
} from './pact-federated-inbound-gates'
export { PACT_STEPS_PER_PACT_CAP } from './pact-federated-inbound-gates'
export type { InboundPactWake } from './pact-federated-inbound-wake'
export type { ApplyInboundPactVerbResult } from './pact-federated-propose-apply'

function noopReceipt(messageId: string, threadId: string): ApplyInboundPactVerbResult {
  return { accepted: true, messageId, threadId, wake: { kind: 'none' } }
}

// D-R140 NF-3 (21b-E12): a `resume_noop` that lands on the pact's next expected seq still
// consumed a delivered wire seq — advance `pact_peer_seq` to it and record the applied id (the
// same dedupe-scoped write the NO_LEDGER_VERBS branch of `applyLedgerOrNoLedgerVerb` uses), one
// transaction, then return the ordinary noop receipt. No message row, no `pact_steps` ledger
// row — this verb had no state effect (the peer was never recorded as paused here), only a
// fence advance.
function applyResumeNoopWithFenceAdvance(
  db: Database.Database,
  thread: ThreadRow,
  args: ApplyInboundPactVerbArgs
): ApplyInboundPactVerbResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE threads SET pact_peer_seq = ?, pact_last_inbound_at = datetime('now'),
         pact_repair_attempts = 0 WHERE id = ?`
    ).run(args.pact.seq, thread.id)
    recordPactAppliedId(db, thread.id, args.messageId, args.pact.verb)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return noopReceipt(args.messageId, thread.id)
}

export function applyInboundPactVerb(
  db: Database.Database,
  args: ApplyInboundPactVerbArgs,
  walkSupersessionChain: SupersessionChainWalker
): ApplyInboundPactVerbResult {
  const peerThreadId = runPactGrammarGate(args) // Gate 7
  const stepDupe = runPactStepsDedupeGate(db, args) // Gate 8a (pact_steps leg, link+sender scoped)
  if (stepDupe.outcome === 'duplicate') {
    return noopReceipt(args.messageId, stepDupe.threadId)
  }

  const resolution = resolvePactThread(db, args, peerThreadId) // Gate 10 (+ propose's gate 12 limb)
  if (resolution.mode === 'release_noop') {
    // A-F17: an inbound `release` on a thread this host has no pact record of is an accepted
    // idempotent no-op (§2.9) — every other verb already refused `pact_no_pact` upstream.
    return noopReceipt(args.messageId, peerThreadId)
  }

  // Gate 8b (D-R134 F16 / D-R135 A2): the no-ledger-verb applied-ids leg, scoped to the now
  // RESOLVED thread — never the wire's own peerThreadId.
  const appliedDupe = runPactAppliedIdsDedupeGate(db, args, resolution.thread.id)
  if (appliedDupe.outcome === 'duplicate') {
    return noopReceipt(args.messageId, resolution.thread.id)
  }

  if (resolution.mode === 'propose') {
    // B10 (design §2.13) — the pair guard + simultaneous cross-propose tie-break now live
    // inside applyPropose itself, ahead of era adoption.
    return applyPropose(db, resolution.thread, args)
  }

  const matrixResult = runPactPartyAndMatrixGates(args, resolution.thread) // Gates 11-13

  // resync_request/resync bypass gate 14's strict fence entirely (§2.5: "the wire dedupe alone
  // is sufficient for it" — gate 8, above, already supplied that). gap_notice gets NO special
  // case here — it is processed exactly as a gap of the shape its seq implies, through the same
  // fence every other verb uses, below.
  if (args.pact.verb === 'resync_request') {
    return applyInboundResyncRequestVerb(db, resolution.thread, args)
  }
  if (args.pact.verb === 'resync') {
    return applyInboundResyncVerb(db, resolution.thread, args)
  }
  if (args.pact.verb === 'rebind_party') {
    return applyInboundRebindPartyVerb(db, resolution.thread, args, walkSupersessionChain)
  }

  // Gate 14 — the strict fence (§2.5, Ruling 34 Addendum 6(2)).
  const fence = resolvePactFenceOutcome(resolution.thread, args.pact.seq)

  // D-R140 NF-3 (21b-E12): the `resume_noop` check moves to AFTER gate 14. The base short-
  // circuited on `resume_noop` BEFORE the fence ever ran, so an inbound resume that coalesced
  // with a pause this receiver never saw (cross-kind seq reuse reuses the replaced row's seq,
  // 21b-E7a) consumed a delivered wire seq that the noop receipt never recorded — the receiver's
  // fence never advanced, and the sender's next verb desynced. When the fence says this seq IS
  // the pact's next expected one, the noop is an APPLIED verb with no state effect: advance
  // `pact_peer_seq`, record the applied id, in the one transaction, then return the noop
  // receipt. A gap/desync fence outcome is a genuine repair case regardless of `resume_noop` —
  // it falls through to the ordinary gap/desync handling below, unchanged.
  if (matrixResult.outcome === 'resume_noop' && fence.kind === 'apply') {
    return applyResumeNoopWithFenceAdvance(db, resolution.thread, args)
  }
  if (fence.kind === 'gap') {
    // The RECEIVER mints a nonce (fresh-nonce gated, NA6) and queues one coalesced
    // resync_request back to the sender — never applied speculatively (v2's tolerance is
    // withdrawn).
    mintResyncRequestIfNeeded(db, resolution.thread.id)
    throw new OrchestrationError(
      'pact_out_of_order',
      `Refused: relayed seq ${args.pact.seq} is not this pact's next expected seq (${resolution.thread.pact_peer_seq + 1}).`,
      {
        nextSteps: [
          'retryable — this host has queued a resync_request to repair the gap; retry once resync completes'
        ]
      }
    )
  }
  if (fence.kind === 'desync') {
    // Terminal — pause + tail-cancel fires on every occurrence; only the audit is metered
    // (§2.9 [v3.1]).
    firePactDesyncDispositionInbound(db, resolution.thread.id, args.pairedDeviceId)
    throw new OrchestrationError(
      'pact_desync',
      `Refused: relayed seq ${args.pact.seq} cannot be explained as a legitimate duplicate or an ` +
        `in-bound gap of this pact's ledger (this host's peer seq is ${resolution.thread.pact_peer_seq}).`,
      {
        nextSteps: [
          `orca agents pact --show ${resolution.thread.id}`,
          `orca agents pact --release --on ${resolution.thread.id}`
        ]
      }
    )
  }
  return applyLedgerOrNoLedgerVerb(db, resolution.thread, args, renderedSenderKey(args))
}

// S10-21b B14 (design §4.6(a)): the per-pact cap at the inbound write — `SELECT COUNT(*) FROM
// pact_steps WHERE actor_is_remote=1 AND thread_id=?` immediately before `insertPactStepRow` on
// the inbound path. Checked (and, on overflow, the auto-pause applied) BEFORE the write
// transaction opens: the refusal and the auto-pause are two separate, deliberate writes — a
// refused write must not also roll back the pause that closes the pact against further growth.
function refuseIfPactStepsOverCap(db: Database.Database, threadId: string): void {
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE actor_is_remote = 1 AND thread_id = ?`)
    .get(threadId) as { n: number }
  if (count.n >= PACT_STEPS_PER_PACT_CAP) {
    autoPauseThreadForLedgerCap(db, threadId)
    throw new OrchestrationError(
      'pact_ledger_capped',
      `Refused: this pact has reached its ${PACT_STEPS_PER_PACT_CAP}-entry remote ledger cap; it has been auto-paused.`,
      { nextSteps: [`orca agents pact --release --on ${threadId}`] }
    )
  }
}

function applyLedgerOrNoLedgerVerb(
  db: Database.Database,
  thread: ThreadRow,
  args: ApplyInboundPactVerbArgs,
  senderKey: string
): ApplyInboundPactVerbResult {
  const { pact } = args
  const noLedger = NO_LEDGER_VERBS.has(pact.verb)
  if (!noLedger) {
    refuseIfPactStepsOverCap(db, thread.id)
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    let turnAfterAgentId: string | null = null
    let ordinal = thread.pact_ordinal
    if (pact.verb === 'accept') {
      turnAfterAgentId = thread.pact_proposer_agent_id
      db.prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?, pact_at = datetime('now'),
           pact_flight_token = pact_flight_token + 1
         WHERE id = ?`
      ).run(turnAfterAgentId, thread.id)
    } else if (pact.verb === 'decline' || pact.verb === 'release') {
      // BINDING (batch-1): inbound PEER release NEVER sets pact_release_at (local-only), else
      // N9's 7-day-delay guarantee degrades.
      db.prepare(
        `UPDATE threads SET pact_state = 'released', pact_turn_agent_id = NULL,
           pact_paused_at = NULL, pact_pause_reason = NULL, pact_at = datetime('now'),
           pact_peer_release_at = CASE WHEN ? = 'release' THEN datetime('now') ELSE pact_peer_release_at END,
           pact_flight_token = pact_flight_token + 1
         WHERE id = ?`
      ).run(pact.verb, thread.id)
    } else if (pact.verb === 'pause') {
      db.prepare(
        `UPDATE threads SET pact_peer_paused_at = datetime('now'), pact_flight_token = pact_flight_token + 1
         WHERE id = ?`
      ).run(thread.id)
    } else if (pact.verb === 'resume') {
      db.prepare(
        `UPDATE threads SET pact_peer_paused_at = NULL, pact_flight_token = pact_flight_token + 1
         WHERE id = ?`
      ).run(thread.id)
    } else if (pact.verb === 'step') {
      // A-F2 (BLOCKER): an applied inbound `step` flips the turn to the OTHER LOCAL party (the
      // local participant that is not the sender's rendered key), in the SAME UPDATE that bumps
      // pact_ordinal — otherwise the local counterpart is permanently refused `not_your_turn`.
      ordinal = thread.pact_ordinal + 1
      turnAfterAgentId = otherLocalParty(thread, senderKey)
      if (turnAfterAgentId === null) {
        // N8: unreachable today (gate 12 guarantees the sender is a named party and exactly one
        // party is local) but the write was unguarded — refuse rather than ever null the turn
        // column out from under the pact.
        throw new OrchestrationError(
          'pact_party_unresolved',
          `Refused: ${thread.id} has no resolvable local counterpart for the turn.`
        )
      }
      db.prepare(
        `UPDATE threads SET pact_ordinal = ?, pact_turn_agent_id = ?, pact_flight_token = pact_flight_token + 1
         WHERE id = ?`
      ).run(ordinal, turnAfterAgentId, thread.id)
    } // gap_notice: no state effect beyond the fence advance + the pact_applied_ids write.
    let messageId = args.messageId
    if (!noLedger) {
      const inserted = insertGatedMessage(db, {
        id: args.messageId,
        from: senderKey,
        to: `agent:${args.toAgentId}`,
        subject: `pact ${pact.verb}`,
        body: args.body ?? '',
        type: 'status',
        threadId: thread.id,
        hostPayloadKind: `pact_${pact.verb}`,
        deliveryContract: pact.verb === 'step' ? 'current_delivery' : 'audit_only',
        runId: 'peer',
        verb: 'federation_import',
        peerLinkDeviceId: args.pairedDeviceId,
        peerAgentId: args.senderAgentId,
        peerThreadId: args.peerThreadId,
        peerRelayedAt: null
      })
      if (inserted.outcome === 'refused') {
        throw new OrchestrationError(
          'gate_refused',
          `The relayed ${pact.verb} was refused by the message gate.`
        )
      }
      bumpThreadOnMessage(db, thread.id, inserted.message)
      messageId = inserted.message.id
      const kind = LEDGER_VERB_KIND[pact.verb]
      if (kind === undefined) {
        throw new Error(`internal error: ${pact.verb} has no ledger kind mapping`)
      }
      insertPactStepRow(db, {
        threadId: thread.id,
        ordinal,
        kind,
        actorAgentId: senderKey,
        actorPaneKey: null,
        actorHostId: args.pairedDeviceId,
        messageId,
        summary: pact.verb === 'step' ? (args.body ?? '').slice(0, 120) : null,
        turnAfterAgentId,
        reasonCode: pact.reasonCode ?? null,
        actorIsRemote: true,
        actorRemoteAgentId: args.senderAgentId,
        actorEnvironmentId: args.senderEnvironmentId,
        relaySeq: pact.seq
      })
    } else {
      // §2.5/§4.5: `pact_applied_ids`, capped at PACT_STEPS_PER_PACT_CAP (commit 14 imports it).
      recordPactAppliedId(db, thread.id, messageId, pact.verb)
    }

    db.prepare(
      `UPDATE threads SET pact_peer_seq = ?, pact_last_inbound_at = datetime('now'),
         pact_repair_attempts = 0 WHERE id = ?`
    ).run(pact.seq, thread.id)

    auditPact(db, {
      agentId: null,
      actorPaneKey: null,
      actorHostId: args.pairedDeviceId,
      verb: `pact_${pact.verb}`,
      outcome: pact.verb === 'accept' ? 'engaged' : pact.verb === 'gap_notice' ? 'noted' : 'applied'
    })
    db.exec('COMMIT')

    return {
      accepted: true,
      messageId,
      threadId: thread.id,
      wake: describeWake(thread, pact.verb, turnAfterAgentId, senderKey)
    }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
