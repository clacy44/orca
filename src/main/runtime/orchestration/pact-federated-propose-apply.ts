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
import { refuseIfLinkCeilingSaturated } from './pact-federated-ledger-ceiling'
import { bumpProposalBlockWindow } from './pact-federated-proposal-block'
import { cancelUnsettledPactOutboxTail } from './pact-federated-repair'

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

  // S10-21b B14 (design §4.6(a), errata NB7) — per-link ceiling, evaluated ONLY here (propose/
  // inbound-propose-apply time), refusing only a NEW pact proposal; never touches an
  // already-engaged pact.
  refuseIfLinkCeilingSaturated(db, args.senderEnvironmentId, args.senderAgentId)

  // S10-21b B14 (design §3.3, errata NB8) — a proposal from this (peer, local agent) pair bumps
  // the per-peer-per-window park-block window on ARRIVAL, regardless of this propose's own
  // eventual outcome (race loss, era mismatch, etc.) — "on arrival" per §3.3's own wording.
  bumpProposalBlockWindow(db, senderKey, args.toAgentId)

  // B10 (design §2.13) — pair guard + cross-propose tie-break (pact-federated-propose-race.ts).
  // 'incoming_wins': auto-decline+relay the local loser before era adoption/apply, below.
  const race = resolveCrossProposeOutcome(db, thread, args, senderKey)
  if (race === 'incoming_wins') {
    declineLosingLocalPropose(db, thread.id, args)
  }

  // A-F8: after the reset, a propose's own seq must be EXACTLY 1 — the peer choosing our fence
  // value (`pact_peer_seq = pact.seq` for an arbitrary seq) let a peer set an arbitrary starting
  // fence, desyncing its own next legitimate verb. Checked before the transaction so a bad seq
  // never touches the era-adoption reset either.
  if (args.pact.seq !== 1) {
    throw new OrchestrationError(
      'pact_out_of_order',
      `Refused: a propose's seq must be 1 (relayed seq ${args.pact.seq}).`
    )
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    // A-F9/B-F7: era adoption now runs INSIDE this transaction (moved from before `BEGIN
    // IMMEDIATE` — its prior auto-commit UPDATE left the era moved and both seqs zeroed with no
    // pact written whenever the apply below then failed, e.g. the message-gate refusal at
    // `gate_refused`).
    adoptEraOnInboundPropose(db, { id: thread.id }, { era: args.pact.era })
    // D-R138 F4: cancel this pact's own unsettled outbox tail as part of the SAME era-reset
    // transaction — a fresh era must not carry a relay item minted under the era it replaced
    // (the cross-propose race's loser: its own pre-race propose/decline rows survived the reset
    // above and retried against the peer's now-live, freshly-won pact).
    cancelUnsettledPactOutboxTail(db, thread.id, { includeSending: false })
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
         pact_peer_thread_id = ?, pact_peer_seq = 1, pact_flight_token = pact_flight_token + 1
       WHERE id = ?`
    ).run(
      senderKey,
      args.toAgentId,
      args.pact.stepsTotal ?? null,
      args.senderAgentId,
      args.pairedDeviceId,
      args.senderEnvironmentId,
      args.peerThreadId,
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
