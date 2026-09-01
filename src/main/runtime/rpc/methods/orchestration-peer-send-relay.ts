// S10-15 F1 R3/R6: the asking-side half of a cross-host relayed SEND — near-copy of
// relayPeerAskToHost's shape (orchestration.ts) for the send verb. Writes the sender's own
// local mirror row FIRST (single write choke, content gate runs exactly once), then relays;
// never throws on a peer-side refusal or an unreachable peer (the local row already exists and
// must not be orphaned by an exception) — only local guard failures throw.
import { randomUUID } from 'node:crypto'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  PEER_RUN_ID,
  type OrchestrationDb,
  type MessageType,
  type MessagePriority
} from '../../orchestration/db'
import { gateVerdictRefusalError } from '../../orchestration/gate-refusal-error'
import { payloadValueForGate } from '../../orchestration/message-gate-writer'
import { buildFederatedSenderIdentity } from '../../orchestration/federated-sender-identity'
import { resolveCallerAgent } from './orchestration-caller-identity'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationCompatibilityEvidence } from '../../../../shared/orchestration-compatibility-evidence'

export async function relayPeerSendToHost(args: {
  params: {
    to: string
    host: string
    subject: string
    body?: string
    type?: string
    priority?: string
    threadId?: string
    payload?: string
    acknowledgeGate?: boolean
  }
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  orchestrationCompatibilityEvidence?: OrchestrationCompatibilityEvidence
  pairedDeviceId?: string
  clientKind?: 'mobile' | 'runtime'
  orchestrationMutation?: { requestId: string }
}): Promise<unknown> {
  const { params, runtime, db } = args
  // Finding 14: a paired peer (or a mobile client) can otherwise reach `orchestration.send` and
  // open a THIRD-hop relay through this host — refuse before any local effect, mirroring
  // orchestration-agents-quarantine.ts:48-53.
  if (args.pairedDeviceId != null || args.clientKind === 'mobile') {
    throw new OrchestrationError('forbidden', 'A cross-host relay must be issued locally.')
  }
  if (!params.to.startsWith('agent:')) {
    throw new OrchestrationError(
      'invalid_argument',
      '--host is only valid with an agent: recipient.'
    )
  }
  const toAgentId = params.to.slice('agent:'.length)

  const caller = resolveCallerAgent(db, runtime, args.orchestrationCompatibilityEvidence)
  const callerRow = db.getAgentById(caller.id)
  // Mirrors relayPeerAskToHost's pre-wire quarantine refusal: `--host` must never be a bypass
  // of local containment.
  if (callerRow?.quarantined === 1) {
    db.writeAgentAudit({
      agentId: callerRow.id,
      actorPaneKey: caller.pane_key,
      actorHostId: caller.host_id,
      verb: 'federatedSend',
      outcome: 'agent_quarantined',
      reasonCode: null
    })
    throw new OrchestrationError(
      'agent_quarantined',
      `${callerRow.display_name} is quarantined and cannot send across hosts.`,
      { nextSteps: [`orca agents quarantine ${callerRow.display_name} --lift`] }
    )
  }

  // R3 (finding 16): three distinct failure modes map to three distinct codes — collapsing them
  // all into `remote_mailbox_unpaired` destroys the actionable difference between "no transport
  // at all" (server_required, already a structured passthrough), "that name matches more than
  // one saved environment" (the store's own `invalid_argument`, whose message already names the
  // fix — use the id), and "no environment by that name" (the only genuine unpaired case).
  let server
  try {
    server = runtime.resolveOrchestrationWorkerServer(params.host)
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'server_required') {
      throw error
    }
    if (error instanceof Error && /is ambiguous/.test(error.message)) {
      throw new OrchestrationError('invalid_argument', error.message)
    }
    throw new OrchestrationError(
      'remote_mailbox_unpaired',
      `No saved environment named "${params.host}" is paired with this host.`,
      { nextSteps: ['orca environment list', 'orca environment add --pairing-code <code>'] }
    )
  }

  const inserted = db.insertGatedMessage({
    from: `agent:${caller.id}`,
    to: `remote:${server.environmentId}:${toAgentId}`,
    subject: params.subject,
    body: params.body,
    type: params.type as MessageType | undefined,
    priority: params.priority as MessagePriority | undefined,
    threadId: params.threadId ?? null,
    payload: payloadValueForGate(params.payload),
    runId: PEER_RUN_ID,
    senderPaneKey: caller.pane_key,
    senderHostId: caller.host_id,
    acknowledgeGate: params.acknowledgeGate,
    verb: 'send',
    peerAgentId: toAgentId,
    peerThreadId: null,
    peerRelayedAt: null
  })
  if (inserted.outcome === 'refused') {
    throw gateVerdictRefusalError(inserted.verdict, inserted.refusalId)
  }
  const message = inserted.message

  let relayResult: unknown
  try {
    relayResult = await runtime.callOrchestrationWorkerServer(
      params.host,
      'orchestration.federatedSend',
      {
        fromAgent: buildFederatedSenderIdentity(db, caller.id),
        toAgentId,
        messageId: message.id,
        threadId: params.threadId ?? null,
        subject: params.subject,
        body: params.body,
        type: params.type,
        priority: params.priority,
        payload: params.payload === undefined ? undefined : JSON.parse(params.payload)
      },
      30_000,
      {
        orchestrationRequestId: args.orchestrationMutation
          ? `relay_send_${args.orchestrationMutation.requestId}`
          : `relay_send_${randomUUID()}`
      }
    )
  } catch (error) {
    // Never throw for a peer-side refusal or an unreachable peer — the local row exists.
    const code = error instanceof OrchestrationError ? error.code : 'runtime_error'
    const reason = error instanceof Error ? error.message : String(error)
    return {
      message,
      relay: {
        destination: 'peer_agent',
        environment: server.name,
        accepted: false,
        code,
        reason
      }
    }
  }
  const result = relayResult as { messageId: string; threadId: string | null }
  db.markPeerRelayAccepted(message.id, result.threadId ?? null)
  return {
    message: db.getMessageById(message.id) ?? message,
    relay: {
      destination: 'peer_agent',
      environment: server.name,
      accepted: true,
      peerMessageId: result.messageId
    }
  }
}
