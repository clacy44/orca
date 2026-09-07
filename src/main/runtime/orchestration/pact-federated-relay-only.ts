// S10-21b D-R139 N1 (split out of pact-federated-emit-steps.ts, max-lines ratchet) —
// `enqueueRelayForAppliedVerb`, the relay-only counterpart to `enqueueFederatedPactVerbWithin`
// for a verb whose local `threads` state AND `pact_steps` ledger row a PRIOR local fallback
// already wrote (the `LinkBindingCapError` branch of `emitFederatedPactSideEffect` in
// pact-federated-pause-resume-emit.ts). Runs ONLY the message-insert and outbox-enqueue halves
// of the primitive — never `threadStateMutation`, never a second `insertPactStepRow` — so the
// drain (pact-federated-rebind.ts's `drainPausedOrResumed`) can never write a second ledger row
// for the same transition; the reason_code of the EXISTING row is what the caller must carry in
// via `opts.reasonCode` (the drain reads it off the latest host pause/resume ledger row).
import type Database from '../../sqlite/sync-database'
import type { GateVerdict } from '../../../shared/message-body-gate'
import { insertGatedMessage } from './message-gate-writer'
import { bumpThreadOnMessage } from './thread-directory'
import { otherPactParticipant, pactWaiterHandle, requireThread } from './pact-shared'
import { isFederatedPact } from './pact-federated-identity'
import { enqueueReplyOutboxCoalesced } from './reply-outbox-pact-answer-coalesce'
import { getPeerLinkBinding, LinkBindingCapError } from './link-binding-store'
import { buildPactWirePayload } from './pact-federated-wire-envelope'
import { PACT_VERB_RELAY_KIND } from './pact-federated-emit-steps'

export type EnqueueRelayForAppliedVerbOpts = {
  actorAgentId: string | null
  actorPaneKey: string | null
  actorHostId: string | null
  runId: string
  reasonCode: string | null
  turnAfterAgentId?: string | null
}

export type EnqueueRelayForAppliedVerbResult =
  | { outcome: 'enqueued'; thread: ReturnType<typeof requireThread>; outboxId: string }
  | { outcome: 'relay_pending'; thread: ReturnType<typeof requireThread> }
  | { outcome: 'refused'; verdict: Extract<GateVerdict, { tier: 'hard' }>; refusalId: number }

// Same `db.inTransaction` precondition as `enqueueFederatedPactVerbWithin`.
export function enqueueRelayForAppliedVerb(
  db: Database.Database,
  threadId: string,
  verb: 'pause' | 'resume',
  opts: EnqueueRelayForAppliedVerbOpts
): EnqueueRelayForAppliedVerbResult {
  if (!db.inTransaction) {
    throw new Error(
      `internal error: enqueueRelayForAppliedVerb called for ${threadId} outside an open transaction`
    )
  }
  const thread = requireThread(db, threadId)
  if (!isFederatedPact(thread)) {
    throw new Error(
      `internal error: enqueueRelayForAppliedVerb called for a local (non-federated) pact on ${threadId}`
    )
  }
  const linkDeviceId = thread.pact_peer_link_device_id
  const environmentId = thread.pact_peer_environment_id
  const peerAgentId = thread.pact_peer_agent_id
  if (linkDeviceId === null || environmentId === null || peerAgentId === null) {
    throw new Error(
      `internal error: federated pact thread ${threadId} is missing a peer anchor column`
    )
  }
  const binding = getPeerLinkBinding(db, linkDeviceId)
  if (!binding) {
    throw new Error(
      `internal error: federated pact thread ${threadId} names link ${linkDeviceId}, which has no peer_link_bindings row`
    )
  }
  const counterpartKey = opts.actorAgentId
    ? otherPactParticipant(thread, opts.actorAgentId)
    : (thread.pact_proposer_agent_id ?? '').startsWith('remote:')
      ? (thread.pact_proposer_agent_id as string)
      : (thread.pact_with_agent_id as string)
  const relayKind = PACT_VERB_RELAY_KIND[verb]

  // Message only — no threadStateMutation, no ledger row (both already exist).
  const inserted = insertGatedMessage(db, {
    from: opts.actorAgentId ? pactWaiterHandle(opts.actorAgentId) : 'host',
    to: counterpartKey,
    subject: `pact ${verb}`,
    body: '',
    type: 'status',
    threadId: thread.id,
    hostPayloadKind: `pact_${verb}`,
    deliveryContract: 'audit_only',
    runId: opts.runId,
    senderPaneKey: opts.actorPaneKey,
    senderHostId: opts.actorHostId ?? 'local',
    verb
  })
  if (inserted.outcome === 'refused') {
    return { outcome: 'refused', verdict: inserted.verdict, refusalId: inserted.refusalId }
  }
  const message = inserted.message
  bumpThreadOnMessage(db, thread.id, message)

  // No coalesce target can exist for a relay this drain mints for the first time (the cap
  // error rolled back the ORIGINAL enqueue's own outbox row entirely) — always a fresh bump.
  db.prepare(`UPDATE threads SET pact_local_seq = pact_local_seq + 1 WHERE id = ?`).run(thread.id)
  const seqRow = db
    .prepare(`SELECT pact_local_seq, pact_era FROM threads WHERE id = ?`)
    .get(thread.id) as { pact_local_seq: number; pact_era: number }
  const seq = seqRow.pact_local_seq
  const era = seqRow.pact_era

  const payloadJson = buildPactWirePayload(db, {
    actorAgentId: opts.actorAgentId,
    verb,
    seq,
    era,
    peerAgentId,
    threadId: thread.id,
    subject: message.subject,
    messageId: message.id,
    reasonCode: opts.reasonCode
  })

  let outboxId: string | null = null
  let pendingAgain = false
  try {
    outboxId = enqueueReplyOutboxCoalesced(db, false, {
      localMessageId: message.id,
      linkDeviceId,
      environmentId,
      boundPairingRevision: binding.boundPairingRevision,
      peerCredentialFp: binding.peerCredentialFp,
      peerKeyFingerprint: binding.peerKeyFingerprint,
      inReplyToMessageId: message.id,
      peerAgentId,
      peerThreadId: thread.pact_peer_thread_id,
      localThreadId: thread.id,
      noticeRunId: null,
      noticePaneKey: opts.actorPaneKey,
      payload: payloadJson,
      byteCount: Buffer.byteLength(payloadJson, 'utf8'),
      createdAt: Date.now(),
      reserved: true,
      pactThreadId: thread.id,
      pactSeq: seq,
      pactEra: era,
      pactTurnAfter: opts.turnAfterAgentId ?? undefined,
      relayKind
    })
  } catch (err) {
    if (err instanceof LinkBindingCapError) {
      // The cap still bites — re-set the SAME token; nothing here duplicates the ledger row
      // (never written by this function) or the state (already applied by the local fallback).
      pendingAgain = true
      db.prepare(`UPDATE threads SET pact_relay_pending = ? WHERE id = ?`).run(verb, thread.id)
    } else {
      throw err
    }
  }

  const updated = requireThread(db, thread.id)
  if (pendingAgain) {
    return { outcome: 'relay_pending', thread: updated }
  }
  return { outcome: 'enqueued', thread: updated, outboxId: outboxId as string }
}
