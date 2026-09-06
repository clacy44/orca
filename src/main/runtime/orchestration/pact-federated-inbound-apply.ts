// S10-21b B8/B9 (design §2.5) — inbound pact-verb APPLY: gate 14's strict fence (exact
// successor / gap / desync, §2.5's full table — B9), per-verb effect, wake descriptor.
// resync_request/resync bypass gate 14 entirely and dispatch straight to
// pact-federated-resync-apply.ts (B9); `rebind_party` still refuses
// `pact_repair_not_yet_available` (B13's). Gates 6-13 live in pact-federated-inbound-gates.ts
// (max-lines split); gate 6 runs in the RPC handler. `pact_ordinal` NEVER comes from the wire
// (INV-P-021).
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import { insertGatedMessage } from './message-gate-writer'
import { bumpThreadOnMessage } from './thread-directory'
import { auditPact, insertPactStepRow } from './pact-shared'
import { adoptEraOnInboundPropose } from './pact-federated-era'
import {
  declineLosingLocalPropose,
  resolveCrossProposeOutcome
} from './pact-federated-propose-race'
import type { ThreadRow } from './types'
import {
  LEDGER_VERB_KIND,
  NO_LEDGER_VERBS,
  recordPactAppliedId,
  renderedSenderKey,
  runPactGrammarGate,
  runPactDedupeGate,
  resolvePactThreadAndGates,
  type ApplyInboundPactVerbArgs
} from './pact-federated-inbound-gates'
import { describeWake, type InboundPactWake } from './pact-federated-inbound-wake'
import {
  firePactDesyncDispositionInbound,
  mintResyncRequestIfNeeded,
  resolvePactFenceOutcome
} from './pact-federated-repair'
import {
  applyInboundResyncRequestVerb,
  applyInboundResyncVerb
} from './pact-federated-resync-apply'

export type {
  ApplyInboundPactVerbArgs,
  InboundPactEnvelope,
  InboundPactVerb
} from './pact-federated-inbound-gates'
export { PACT_STEPS_PER_PACT_CAP } from './pact-federated-inbound-gates'
export type { InboundPactWake } from './pact-federated-inbound-wake'

export type ApplyInboundPactVerbResult = {
  accepted: true
  messageId: string
  threadId: string
  wake: InboundPactWake
}

export function applyInboundPactVerb(
  db: Database.Database,
  args: ApplyInboundPactVerbArgs
): ApplyInboundPactVerbResult {
  const peerThreadId = runPactGrammarGate(args) // Gate 7
  const dedupe = runPactDedupeGate(db, args, peerThreadId) // Gate 8
  if (dedupe.outcome === 'duplicate') {
    return {
      accepted: true,
      messageId: args.messageId,
      threadId: dedupe.threadId,
      wake: { kind: 'none' }
    }
  }
  const resolution = resolvePactThreadAndGates(db, args, peerThreadId) // Gates 9-13
  if (resolution.mode === 'propose') {
    // B10 (design §2.13) — the pair guard + simultaneous cross-propose tie-break now live
    // inside applyPropose itself, ahead of era adoption.
    return applyPropose(db, resolution.thread, args)
  }

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

  // Gate 14 — the strict fence (§2.5, Ruling 34 Addendum 6(2)).
  const fence = resolvePactFenceOutcome(resolution.thread, args.pact.seq)
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

function applyPropose(
  db: Database.Database,
  thread: ThreadRow,
  args: ApplyInboundPactVerbArgs
): ApplyInboundPactVerbResult {
  const senderKey = renderedSenderKey(args)
  // B10 (design §2.13) — pair guard + cross-propose tie-break (pact-federated-propose-race.ts).
  // 'incoming_wins': auto-decline+relay the local loser before era adoption/apply, below.
  const race = resolveCrossProposeOutcome(db, thread, args, senderKey)
  if (race === 'incoming_wins') {
    declineLosingLocalPropose(db, thread.id, args)
  }

  // Era adoption + seq reset (B6, chair answer 3) — called, never re-derived.
  adoptEraOnInboundPropose(db, { id: thread.id }, { era: args.pact.era })

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE threads SET
         pact_proposer_agent_id = ?, pact_with_agent_id = ?, pact_state = 'proposed',
         pact_steps_total = ?, pact_ordinal = 0, pact_turn_agent_id = NULL,
         pact_paused_at = NULL, pact_pause_reason = NULL, pact_at = datetime('now'),
         pact_release_at = NULL, pact_peer_release_at = NULL, pact_turn_in_flight_at = NULL,
         pact_peer_paused_at = NULL, pact_last_inbound_at = datetime('now'),
         pact_last_resync_at = NULL, pact_relay_pending = NULL, pact_resync_nonce = NULL,
         pact_resync_nonce_at = NULL, pact_repair_attempts = 0,
         pact_peer_agent_id = ?, pact_peer_link_device_id = ?, pact_peer_environment_id = ?,
         pact_peer_thread_id = ?, pact_peer_seq = ?
       WHERE id = ?`
    ).run(
      senderKey,
      args.toAgentId,
      args.pact.stepsTotal ?? null,
      args.senderAgentId,
      args.pairedDeviceId,
      args.senderEnvironmentId,
      args.peerThreadId,
      args.pact.seq,
      thread.id
    )
    const inserted = insertGatedMessage(db, {
      id: args.messageId,
      from: senderKey,
      to: `agent:${args.toAgentId}`,
      subject: 'pact propose',
      body: args.body ?? '',
      type: 'status',
      threadId: thread.id,
      hostPayloadKind: 'pact_propose',
      deliveryContract: 'audit_only',
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
        'The relayed propose was refused by the message gate.'
      )
    }
    bumpThreadOnMessage(db, thread.id, inserted.message)
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: 0,
      kind: 'propose',
      actorAgentId: senderKey,
      actorPaneKey: null,
      actorHostId: args.pairedDeviceId,
      messageId: inserted.message.id,
      summary: null,
      turnAfterAgentId: null,
      reasonCode: null,
      actorIsRemote: true,
      actorRemoteAgentId: args.senderAgentId,
      actorEnvironmentId: args.senderEnvironmentId,
      relaySeq: args.pact.seq
    })
    auditPact(db, {
      agentId: null,
      actorPaneKey: null,
      actorHostId: args.pairedDeviceId,
      verb: 'pact_propose',
      outcome: 'proposed'
    })
    db.exec('COMMIT')
    return {
      accepted: true,
      messageId: inserted.message.id,
      threadId: thread.id,
      wake: { kind: 'proposed', toAgentId: args.toAgentId, threadId: thread.id }
    }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
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
  db.exec('BEGIN IMMEDIATE')
  try {
    let turnAfterAgentId: string | null = null
    let ordinal = thread.pact_ordinal
    if (pact.verb === 'accept') {
      turnAfterAgentId = thread.pact_proposer_agent_id
      db.prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?, pact_at = datetime('now')
         WHERE id = ?`
      ).run(turnAfterAgentId, thread.id)
    } else if (pact.verb === 'decline' || pact.verb === 'release') {
      // BINDING (batch-1): inbound PEER release NEVER sets pact_release_at (local-only), else
      // N9's 7-day-delay guarantee degrades.
      db.prepare(
        `UPDATE threads SET pact_state = 'released', pact_turn_agent_id = NULL,
           pact_paused_at = NULL, pact_pause_reason = NULL, pact_at = datetime('now'),
           pact_peer_release_at = CASE WHEN ? = 'release' THEN datetime('now') ELSE pact_peer_release_at END
         WHERE id = ?`
      ).run(pact.verb, thread.id)
    } else if (pact.verb === 'pause') {
      db.prepare(`UPDATE threads SET pact_peer_paused_at = datetime('now') WHERE id = ?`).run(
        thread.id
      )
    } else if (pact.verb === 'resume') {
      db.prepare(`UPDATE threads SET pact_peer_paused_at = NULL WHERE id = ?`).run(thread.id)
    } else if (pact.verb === 'step') {
      ordinal = thread.pact_ordinal + 1
      db.prepare(`UPDATE threads SET pact_ordinal = ? WHERE id = ?`).run(ordinal, thread.id)
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
