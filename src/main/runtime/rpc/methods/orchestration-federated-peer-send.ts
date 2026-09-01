// S10-15 (chair ruling 1 / F1 R4-R7): the receiving half of a cross-host relayed SEND. Thin
// wrapper around the shared importer (federated-sender-identity.ts) — never a second copy of
// its guards. Ruling 1's inbound plain-mail policy: quarantined/fingerprint-conflicting sender
// -> typed refusal of the mail; malformed/absent identity -> DELIVER the mail unattributed, skip
// the remote_agents mirror (the importer already skipped it), write an audit row.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  PEER_RUN_ID,
  isUnauthenticatedLaneCallerFingerprint,
  type MessageType
} from '../../orchestration/db'
import { requireAddressableAgentRecipient } from '../../orchestration/addressable-agent-recipient'
import { gateVerdictRefusalError } from '../../orchestration/gate-refusal-error'
import { payloadValueForGate } from '../../orchestration/message-gate-writer'
import { extractPayloadKind } from '../../orchestration/message-waiter-thread-keying'
import {
  FederatedSenderIdentitySchema,
  importFederatedSenderIdentity
} from '../../orchestration/federated-sender-identity'

const RELAYED_MESSAGE_ID_RE = /^msg_[0-9a-f]{12}$/

const FederatedSendParams = z.object({
  // Optional (D3): an old sender, or one whose pane has no registered `agents` row, omits it.
  fromAgent: FederatedSenderIdentitySchema.optional(),
  toAgentId: requiredString('Missing target agent id'),
  messageId: requiredString('Missing relayed message id'),
  threadId: OptionalString,
  subject: requiredString('Missing subject'),
  body: OptionalString,
  type: z.string().optional(),
  priority: z.enum(['normal', 'high', 'urgent']).optional(),
  payload: z.unknown().optional()
})

type FederatedSendResult = {
  accepted: true
  messageId: string
  threadId: string | null
}

export const ORCHESTRATION_FEDERATED_PEER_SEND_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.federatedSend',
    params: FederatedSendParams,
    handler: (params, { runtime, authenticatedCallerFingerprint, pairedDeviceId, clientKind }) => {
      const db = runtime.getOrchestrationDb()
      let toAgentIdForAudit: string | null = null
      try {
        // Same auth-lane check federatedAsk runs (R4): "the link does the authentication" — a
        // genuine paired runtime always carries both; refusing whichever is missing keeps this
        // unsatisfiable by an unattested local caller.
        if (
          !pairedDeviceId ||
          clientKind !== 'runtime' ||
          isUnauthenticatedLaneCallerFingerprint(authenticatedCallerFingerprint)
        ) {
          throw new OrchestrationError(
            'unauthenticated_lane',
            'Cross-host send requires an authenticated paired-runtime link, not a local caller.',
            {
              nextSteps: [
                'this call must arrive over a paired runtime link, never a local pane or an old CLI — re-pair the two hosts if this persists'
              ]
            }
          )
        }
        const toAgent = requireAddressableAgentRecipient(db, params.toAgentId)
        toAgentIdForAudit = toAgent.id

        const imported = importFederatedSenderIdentity(db, {
          identity: params.fromAgent,
          linkKey: pairedDeviceId,
          peerFingerprint: authenticatedCallerFingerprint as string,
          verb: 'send'
        })
        // Ruling 1: quarantined / fingerprint-conflicting sender -> refuse the mail outright.
        if (imported.outcome === 'quarantined' || imported.outcome === 'fingerprint_conflict') {
          throw imported.error
        }

        // Ruling 1 class B: malformed/absent identity delivers, unattributed, mirror skipped.
        let askerHandle: string
        let peerAgentId: string | null
        if (imported.outcome === 'imported' || imported.outcome === 'capped') {
          askerHandle = imported.askerHandle
          peerAgentId = params.fromAgent?.id ?? null
        } else {
          if (imported.outcome === 'invalid') {
            // S10-15 review F8: unified with the importer's own cap-path audit verb
            // (federated-sender-identity.ts) — one name for every class-B/cap identity-rejection
            // audit, distinct from the outer catch's broader 'federatedSend' (any refusal).
            db.writeAgentAudit({
              agentId: toAgentIdForAudit,
              actorPaneKey: null,
              actorHostId: pairedDeviceId,
              verb: 'federatedSendIdentity',
              outcome: `identity_rejected:${imported.reason}`,
              reasonCode: null
            })
          }
          askerHandle = `remote:${pairedDeviceId}:unverified`
          peerAgentId = null
        }

        if (!RELAYED_MESSAGE_ID_RE.test(params.messageId)) {
          throw new OrchestrationError(
            'invalid_argument',
            'The relayed message id is not a valid message id.',
            {
              nextSteps: [
                'this indicates a version-mismatched or malformed peer relay — update Orca on the asking host'
              ]
            }
          )
        }
        // Idempotent replay vs conflict (mirrors importFederatedRelayItem's conflict rule,
        // db.ts): a peer-chosen id that already exists on this host either matches (a retry —
        // return the stored receipt) or conflicts (refuse). Finding 21: this distinction is a
        // 48-bit existence oracle for an arbitrary msg_* id; accepted as designed (2^48 makes
        // enumeration impractical) and stated here per the Gate-1 justification.
        const existing = db.getMessageById(params.messageId)
        if (existing) {
          // S10-15 review m-1: R7 step 2 also required matching `type` — without it, a real id
          // collision with a DIFFERENT type (e.g. a genuine msg_* clash presenting a different
          // message shape under the same id) was silently swallowed as an idempotent "accepted"
          // replay instead of refusing request_mismatch.
          if (
            existing.to_handle === `agent:${toAgent.id}` &&
            existing.peer_link_device_id === pairedDeviceId &&
            existing.type === (params.type ?? 'status')
          ) {
            return {
              accepted: true,
              messageId: existing.id,
              threadId: existing.thread_id
            } satisfies FederatedSendResult
          }
          throw new OrchestrationError(
            'request_mismatch',
            `Relayed message ${params.messageId} conflicts with an existing message on this host.`
          )
        }

        const inserted = db.insertGatedMessage({
          id: params.messageId,
          from: askerHandle,
          to: `agent:${toAgent.id}`,
          subject: params.subject,
          body: params.body,
          type: (params.type ?? 'status') as MessageType,
          priority: params.priority,
          // S10-15 verifier F2: no local thread exists on the receiver for the sender's own
          // threadId — storing it verbatim would point messages.thread_id at a thread row that
          // is never minted here. peer_thread_id (below) is the correct home for the peer's id.
          threadId: null,
          payload: payloadValueForGate(
            params.payload === undefined ? undefined : JSON.stringify(params.payload)
          ),
          runId: PEER_RUN_ID,
          infraAllowlist: [],
          verb: 'federation_import',
          peerLinkDeviceId: pairedDeviceId,
          peerAgentId,
          peerThreadId: params.threadId ?? null,
          peerRelayedAt: null
        })
        if (inserted.outcome === 'refused') {
          throw gateVerdictRefusalError(inserted.verdict, inserted.refusalId)
        }
        const message = inserted.message
        runtime.notifyMessageArrived(
          message.to_handle,
          message.type,
          message.thread_id,
          extractPayloadKind(message.payload_kind)
        )
        return {
          accepted: true,
          messageId: message.id,
          threadId: message.thread_id
        } satisfies FederatedSendResult
      } catch (error) {
        if (error instanceof OrchestrationError) {
          db.writeAgentAudit({
            agentId: toAgentIdForAudit,
            actorPaneKey: null,
            actorHostId: pairedDeviceId ?? null,
            verb: 'federatedSend',
            outcome: error.code,
            reasonCode: null
          })
        }
        throw error
      }
    }
  })
]
