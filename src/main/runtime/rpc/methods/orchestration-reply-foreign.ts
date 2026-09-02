// S10-16 C5, R16.2/R16.3: `enqueueForeignReply` — the durable commit for a reply to a
// foreign-origin row (R16's "commit, never dial") — and `noReturnRoute`. Split out of
// orchestration.ts to keep that file under its baseline (plan §5).
import { randomBytes } from 'node:crypto'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  LinkBindingCapError,
  type PeerLinkBindingRow
} from '../../orchestration/link-binding-store'
import { gateVerdictRefusalError } from '../../orchestration/gate-refusal-error'
import { assertThreadNotSensitiveForFederation } from './orchestration-sensitive-thread-guard'
import { REPLY_OUTBOX_MAX_BYTES } from '../../orchestration/link-binding-constants'
import type { MessageRow } from '../../orchestration/types'

export type ReplyParamsShape = {
  body: string
  acknowledgeGate?: boolean
  // Additive, optional (R16.2): when given, must equal the proven destination's own name or the
  // verb refuses `not_the_addressee` before the transaction opens.
  expectHost?: string
}

export type EnqueueForeignReplyArgs = {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  original: MessageRow
  binding: PeerLinkBindingRow
  params: ReplyParamsShape
  replySenderPaneKey: string | null | undefined
  replySenderHostId: string
  /** R16 v6/lifecycle M6: set only on the local-evidence-unavailable enqueue branch. */
  heldCause?: 'local_evidence_unavailable'
}

export type EnqueueForeignReplyResult = {
  message: { id: string }
  relay: {
    destination: 'peer_link'
    environment: string
    accepted: true
    state: 'queued'
    outboxId: string
    link: string
  }
}

// R16.2: `enqueueForeignReply` — commit, never dial.
export function enqueueForeignReply(args: EnqueueForeignReplyArgs): EnqueueForeignReplyResult {
  const { db, runtime, original, binding, params } = args
  // The caller (orchestration.ts) already refused `sender_unverified` when this is null; a
  // defensive re-check keeps this function's own types honest without inventing an addressee.
  if (original.peer_agent_id == null) {
    throw noReturnRoute(original, 'sender_unverified')
  }
  const peerAgentId = original.peer_agent_id

  // (0) Sensitive-thread gate, before anything (a fourth federation egress, Ruling 13 F1).
  assertThreadNotSensitiveForFederation(db, original.thread_id)

  // --expect-host: an assertion that can only narrow a destination the proof already fixed.
  const environmentName = runtime.resolveOrchestrationWorkerServer(binding.environmentId).name
  if (params.expectHost !== undefined && params.expectHost !== environmentName) {
    throw new OrchestrationError(
      'not_the_addressee',
      `--expect-host ${params.expectHost} does not match the proven destination ${environmentName}.`
    )
  }

  // The replying caller's own agent identity, mirroring `relayPeerSendToHost`'s
  // `buildFederatedSenderIdentity` — `fromAgent` is OPTIONAL on the wire schema (never `null`;
  // an unresolvable caller omits the key entirely, taking Ruling 1 class B's unattributed path
  // on the receiver, exactly as a plain send with no registered caller does).
  const replySenderAgent = args.replySenderPaneKey
    ? db.getAgentByPaneKey(args.replySenderHostId, args.replySenderPaneKey)
    : undefined
  const fromAgent = replySenderAgent
    ? {
        id: replySenderAgent.id,
        displayName: replySenderAgent.display_name,
        role: replySenderAgent.role,
        quarantined: replySenderAgent.quarantined === 1
      }
    : undefined

  // The reply's OWN id — minted here (matching message-gate-writer.ts's `msg_` + 12-hex shape)
  // so the wire payload's `messageId` (the id THIS row will carry on the peer) can be fixed
  // before `insertGatedMessage` runs, rather than colliding with `original.id` (the message
  // being answered, which the peer already holds under that id — R17.1's idempotency key).
  const replyMessageId = `msg_${randomBytes(6).toString('hex')}`

  // R16.3: capacity refusal, never eviction.
  const canonicalPayload = {
    ...(fromAgent ? { fromAgent } : {}),
    toAgentId: peerAgentId,
    messageId: replyMessageId,
    threadId: original.peer_thread_id,
    inReplyToMessageId: original.id,
    subject: `Re: ${original.subject}`,
    body: params.body,
    type: 'status',
    priority: 'normal'
  }
  const payloadJson = JSON.stringify(canonicalPayload)
  const byteCount = Buffer.byteLength(payloadJson, 'utf8')
  if (byteCount > REPLY_OUTBOX_MAX_BYTES) {
    throw new OrchestrationError(
      'link_binding_conflict',
      `This reply exceeds the ${REPLY_OUTBOX_MAX_BYTES}-byte reply-outbox limit.`,
      { nextSteps: ['shorten the reply body'] }
    )
  }

  // (1) insertGatedMessage runs BEFORE any transaction (peer-question.ts:48-51's own precedent —
  // its HARD-refusal path writes its own gate_refusals row that must survive a later refusal).
  const inserted = db.insertGatedMessage({
    id: replyMessageId,
    from: original.to_handle,
    to: `remote:${binding.environmentId}:${peerAgentId}`,
    subject: `Re: ${original.subject}`,
    body: params.body,
    threadId: original.thread_id,
    runId: original.run_id,
    senderPaneKey: args.replySenderPaneKey,
    senderHostId: args.replySenderHostId,
    acknowledgeGate: params.acknowledgeGate,
    verb: 'reply',
    peerAgentId
    // peerLinkDeviceId intentionally omitted: that column marks an INBOUND-imported row only;
    // this is an outbound relay mirror (R16.2, PART 0.7).
  })
  if (inserted.outcome === 'refused') {
    throw gateVerdictRefusalError(inserted.verdict, inserted.refusalId)
  }
  const message = inserted.message

  // (2) audit + enqueue + markAsRead, ONE transaction (db.ts's enqueueForeignReplyIntent).
  let outboxId: string
  try {
    outboxId = db.enqueueForeignReplyIntent({
      audit: {
        agentId: null,
        actorPaneKey: args.replySenderPaneKey ?? null,
        actorHostId: binding.linkDeviceId,
        verb: 'replyRelayIntent',
        outcome: `destination:${binding.environmentId}`,
        reasonCode: args.heldCause ?? null
      },
      outbox: {
        localMessageId: message.id,
        linkDeviceId: binding.linkDeviceId,
        environmentId: binding.environmentId,
        boundPairingRevision: binding.boundPairingRevision,
        peerCredentialFp: binding.peerCredentialFp,
        peerKeyFingerprint: binding.peerKeyFingerprint,
        inReplyToMessageId: original.id,
        peerAgentId,
        peerThreadId: original.peer_thread_id ?? null,
        localThreadId: original.thread_id,
        // P12: NEVER original.run_id (every foreign-origin row is PEER_RUN_ID) — captured from
        // the replying caller's OWN pane, or NULL if it has none (R19.3 drops the notice,
        // audited rather than misdelivered).
        noticeRunId: args.replySenderPaneKey
          ? (db.getCurrentRunForPane(args.replySenderPaneKey)?.id ?? null)
          : null,
        noticePaneKey: args.replySenderPaneKey ?? null,
        payload: payloadJson,
        byteCount,
        createdAt: Date.now()
      },
      markAsReadIds: [original.id]
    })
  } catch (error) {
    // R16.3: capacity refusal, never eviction.
    if (error instanceof LinkBindingCapError) {
      throw new OrchestrationError(
        'link_binding_conflict',
        `This link's reply outbox is at capacity.`,
        { nextSteps: ['orca environment link-status --outbox'] }
      )
    }
    throw error
  }

  // (3) Outside the transaction: fire-and-forget kick.
  runtime.replyOutbox?.kick(binding.linkDeviceId)

  return {
    message: { id: message.id },
    relay: {
      destination: 'peer_link',
      environment: environmentName,
      accepted: true,
      state: 'queued',
      outboxId,
      link: binding.linkDeviceId
    }
  }
}

export type NoReturnRouteHealth =
  | 'unpaired'
  | 'contested'
  | 'revoked'
  | 'quarantined'
  | 'unavailable'

// R16: the typed, actionable refusal for "no route back" — quarantined / sender-unverified / no
// binding at all / a binding that failed even the local-evidence branch.
export function noReturnRoute(
  original: Pick<MessageRow, 'id'>,
  reason: 'quarantined' | 'sender_unverified' | NoReturnRouteHealth
): OrchestrationError {
  if (reason === 'quarantined') {
    return new OrchestrationError(
      'no_return_route',
      `Message ${original.id} arrived over a link that is now quarantined on this host.`
    )
  }
  if (reason === 'sender_unverified') {
    return new OrchestrationError(
      'no_return_route',
      `Message ${original.id}'s sender identity could not be verified; there is no addressee to reply to.`
    )
  }
  return new OrchestrationError(
    'no_return_route',
    `Message ${original.id} arrived from another host; this host has no automatic route back ` +
      `to its sender (link health: ${reason}).`,
    {
      nextSteps: [
        'orca agents ask <name>@<host> "…" — start a fresh cross-host thread with the sender instead',
        'orca environment list'
      ]
    }
  )
}

// R16: a minimal health word for the no_return_route message only — the full R21 describer is
// C6's job (shared/link-binding-health.ts's own doc comment). Never exported beyond this file.
export function healthForNoReturnRoute(
  db: OrchestrationDb,
  linkDeviceId: string
): NoReturnRouteHealth {
  if (db.isPeerLinkQuarantined(linkDeviceId)) {
    return 'quarantined'
  }
  const row = db.getPeerLinkBinding(linkDeviceId)
  if (!row) {
    return 'unpaired'
  }
  if (row.state === 'revoked') {
    return 'revoked'
  }
  if (row.state === 'contested') {
    return 'contested'
  }
  return 'unavailable'
}
