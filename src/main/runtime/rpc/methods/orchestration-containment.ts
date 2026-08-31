// S10-2b PURGE/QUARANTINE §: orchestration.messages.purge and orchestration.agents.review.
// orchestration.agents.quarantine already shipped in S10-1b (orchestration-agents-quarantine.ts,
// ORCHESTRATION_AGENT_METHODS) — not duplicated here. Identity is ONLY
// runtime.verifyOrchestrationCompatibilityCaller (never a caller-supplied handle), matching
// every other S10-2b surface.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { gateVerdictRefusalError } from '../../orchestration/gate-refusal-error'
import { hostIdFor, toPublicAgentView } from './agent-directory-rpc-view'
import type { OrchestrationDb } from '../../orchestration/db'
import type { MessageRow, ThreadParticipantRow } from '../../orchestration/types'

const PurgeParams = z
  .object({
    messageId: OptionalString,
    threadId: OptionalString,
    reason: requiredString('Missing --reason'),
    acknowledgeGate: z.boolean().optional()
  })
  .superRefine((params, ctx) => {
    if ((params.messageId ? 1 : 0) + (params.threadId ? 1 : 0) !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose exactly one of --message or --thread.'
      })
    }
  })

const ReviewParams = z.object({
  agentId: requiredString('Missing --agent-id'),
  limit: OptionalFiniteNumber
})

type PurgeActor = {
  agentId: string | null
  paneKey: string | null
  handle: string | null
  isFederatedCaller: boolean
}

function resolvePurgeActor(
  runtime: Parameters<RpcMethod['handler']>[1]['runtime'],
  orchestrationCompatibilityEvidence: Parameters<
    RpcMethod['handler']
  >[1]['orchestrationCompatibilityEvidence'],
  pairedDeviceId: string | null | undefined,
  clientKind: string | undefined
): PurgeActor {
  const db = runtime.getOrchestrationDb()
  const hostId = hostIdFor(runtime)
  const attested = runtime.verifyOrchestrationCompatibilityCaller(
    orchestrationCompatibilityEvidence,
    { currentRuntimeLaunchSufficient: true }
  )
  if (!attested) {
    throw new OrchestrationError(
      'no_pane_identity',
      'orca agents purge requires an attested caller identity.',
      { nextSteps: ['orca agents register --name <slug> --role "<your role>"'] }
    )
  }
  const agent = db.getAgentByPaneKey(hostId, attested.paneKey)
  return {
    agentId: agent?.id ?? null,
    paneKey: attested.paneKey,
    handle: attested.terminalHandle,
    // Why the same federated test as quarantine (orchestration-agents-quarantine.ts): a
    // federated caller (paired mobile device, or a remote peer) is never the "local operator"
    // PURGE § reserves bulk/any-message authority for.
    isFederatedCaller: pairedDeviceId != null || clientKind === 'mobile'
  }
}

function isOwnMessage(message: MessageRow, actor: PurgeActor): boolean {
  if (actor.agentId && message.sender_agent_id === actor.agentId) {
    return true
  }
  if (actor.handle && message.from_handle === actor.handle) {
    return true
  }
  return actor.agentId !== null && message.from_handle === `agent:${actor.agentId}`
}

function isThreadOwner(participants: readonly ThreadParticipantRow[], actor: PurgeActor): boolean {
  const key = actor.agentId ?? actor.handle
  if (!key) {
    return false
  }
  return participants.some((p) => p.participant_key === key && p.role === 'owner' && !p.left_at)
}

// PURGE § Authority: any attested participant may purge their OWN message; a thread owner or a
// local non-federated operator may purge any message on the thread (or, for a local operator,
// any message at all — the "local, non-federated" half of the rule is what stands in for "no
// thread owner to ask" on a standalone message).
function requirePurgeAuthority(db: OrchestrationDb, message: MessageRow, actor: PurgeActor): void {
  if (isOwnMessage(message, actor)) {
    return
  }
  if (!actor.isFederatedCaller) {
    return
  }
  if (message.thread_id) {
    const participants = db.listThreadParticipants(message.thread_id)
    if (isThreadOwner(participants, actor)) {
      return
    }
  }
  throw new OrchestrationError(
    'forbidden',
    `Not authorized to purge message ${message.id}: not its author, not the thread owner, and not a local operator.`
  )
}

export const ORCHESTRATION_CONTAINMENT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.messages.purge',
    params: PurgeParams,
    handler: (
      params,
      { runtime, orchestrationCompatibilityEvidence, pairedDeviceId, clientKind }
    ) => {
      const db = runtime.getOrchestrationDb()
      const actor = resolvePurgeActor(
        runtime,
        orchestrationCompatibilityEvidence,
        pairedDeviceId,
        clientKind
      )

      if (params.messageId) {
        const existing = db.getMessageById(params.messageId)
        if (!existing) {
          throw new OrchestrationError('not_found', `Message ${params.messageId} was not found.`)
        }
        requirePurgeAuthority(db, existing, actor)
        const result = db.purgeMessage({
          messageId: params.messageId,
          reason: params.reason,
          purgedByAgentId: actor.agentId,
          actorPaneKey: actor.paneKey,
          acknowledgeGate: params.acknowledgeGate
        })
        if (result.outcome === 'refused') {
          throw gateVerdictRefusalError(result.verdict, result.refusalId)
        }
        // Why unreachable in practice: `existing` above already proved the message exists in
        // this same call, so purgeMessage's own 'not_found' cannot fire here — handled anyway
        // because PurgeMessageResult's type is a full union.
        if (result.outcome === 'not_found') {
          throw new OrchestrationError('not_found', `Message ${params.messageId} was not found.`)
        }
        return {
          outcome: result.outcome,
          message: result.message,
          alreadyPurged: result.alreadyPurged
        }
      }

      const threadId = params.threadId as string
      const thread = db.getThread(threadId)
      if (!thread) {
        throw new OrchestrationError('not_found', `Thread ${threadId} was not found.`)
      }
      if (actor.isFederatedCaller && !isThreadOwner(db.listThreadParticipants(threadId), actor)) {
        throw new OrchestrationError(
          'forbidden',
          `Not authorized to purge thread ${threadId}: not the thread owner and not a local operator.`
        )
      }
      const result = db.purgeThread({
        threadId,
        reason: params.reason,
        purgedByAgentId: actor.agentId,
        actorPaneKey: actor.paneKey,
        acknowledgeGate: params.acknowledgeGate
      })
      if (result.outcome === 'refused') {
        throw gateVerdictRefusalError(result.verdict, result.refusalId)
      }
      return { outcome: result.outcome, purgedCount: result.purgedCount }
    }
  }),

  // Operator-only read path that returns a withheld body (PURGE §) — never pushed into a pane,
  // never --format-injected. A quarantined agent's rows are otherwise invisible to every other
  // read path in the tree (message-visibility-filter.ts); without this, an operator quarantines
  // blind and lifts on vibes.
  defineMethod({
    name: 'orchestration.agents.review',
    params: ReviewParams,
    handler: (params, { runtime, pairedDeviceId, clientKind }) => {
      const isFederatedCaller = pairedDeviceId != null || clientKind === 'mobile'
      if (isFederatedCaller) {
        throw new OrchestrationError(
          'forbidden',
          'orca agents review must be issued locally, by a non-federated caller.'
        )
      }
      const db = runtime.getOrchestrationDb()
      const target = db.getAgentById(params.agentId)
      if (!target) {
        throw new OrchestrationError('not_found', `Agent ${params.agentId} was not found.`, {
          nextSteps: ['orca agents list']
        })
      }
      const messages = db.listMessagesByAuthor({
        senderAgentId: params.agentId,
        limit: params.limit
      })
      return { agent: toPublicAgentView(target, true), messages }
    }
  })
]
