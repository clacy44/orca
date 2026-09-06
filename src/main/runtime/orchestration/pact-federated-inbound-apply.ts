// S10-21b B8 (design §2.5's happy-path fence row) — inbound pact-verb APPLY: gate 14's
// successor check (`seq == pact_peer_seq + 1`), per-verb effect, wake descriptor. Gates 6-13
// live in pact-federated-inbound-gates.ts (max-lines split); gate 6 runs in the RPC handler.
// NOT the strict fence (gap/desync/`resync` — commit 9; `rebind_party` — commit 13; both refuse
// `pact_repair_not_yet_available`). `pact_ordinal` NEVER comes from the wire (INV-P-021).
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import { insertGatedMessage } from './message-gate-writer'
import { bumpThreadOnMessage } from './thread-directory'
import { auditPact, insertPactStepRow, requireUnclaimedPact } from './pact-shared'
import { adoptEraOnInboundPropose } from './pact-federated-era'
import type { ThreadRow } from './types'
import {
  LEDGER_VERB_KIND,
  NO_LEDGER_VERBS,
  PACT_STEPS_PER_PACT_CAP,
  renderedSenderKey,
  runPactGrammarGate,
  runPactDedupeGate,
  resolvePactThreadAndGates,
  type ApplyInboundPactVerbArgs
} from './pact-federated-inbound-gates'
import { describeWake, type InboundPactWake } from './pact-federated-inbound-wake'

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
    requireUnclaimedPact(resolution.thread)
    return applyPropose(db, resolution.thread, args)
  }

  // Gate 14 happy-path only (§2.5's first row; gap/desync are commit 9's).
  if (args.pact.seq !== resolution.thread.pact_peer_seq + 1) {
    throw new OrchestrationError(
      'pact_out_of_order',
      `Refused: relayed seq ${args.pact.seq} is not this pact's next expected seq (${resolution.thread.pact_peer_seq + 1}).`,
      {
        nextSteps: [
          'this indicates a lost or reordered relay item — commit 9 lands the repair path'
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
      renderedSenderKey(args),
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
      from: renderedSenderKey(args),
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
      actorAgentId: renderedSenderKey(args),
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
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM pact_applied_ids WHERE thread_id = ?`)
        .get(thread.id) as { n: number }
      if (count.n >= PACT_STEPS_PER_PACT_CAP) {
        throw new OrchestrationError(
          'pact_ledger_capped',
          `Refused: this pact has reached its ${PACT_STEPS_PER_PACT_CAP}-entry no-ledger-verb cap.`
        )
      }
      db.prepare(
        `INSERT INTO pact_applied_ids (thread_id, message_id, verb, applied_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).run(thread.id, messageId, pact.verb)
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
