// S10-21b B8/B10 (design §2.5, §2.13) — inbound `propose` APPLY: the pair guard + simultaneous
// cross-propose tie-break (B10), era adoption (B6), then the anchor-column write + ledger insert.
// Split out of pact-federated-inbound-apply.ts (B13's rebind_party wiring pushed that file over
// the max-lines ratchet) — a pure extraction, no behaviour change.
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
import { renderedSenderKey, type ApplyInboundPactVerbArgs } from './pact-federated-inbound-gates'
import type { InboundPactWake } from './pact-federated-inbound-wake'

export type ApplyInboundPactVerbResult = {
  accepted: true
  messageId: string
  threadId: string
  wake: InboundPactWake
}

export function applyPropose(
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
