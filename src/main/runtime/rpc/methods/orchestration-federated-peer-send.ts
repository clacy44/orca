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
  isHostMessageId,
  requireHostMessageId,
  requireOptionalThreadId
} from '../../orchestration/orchestration-id-grammar'
import {
  FederatedSenderIdentitySchema,
  importFederatedSenderIdentity
} from '../../orchestration/federated-sender-identity'
import {
  refuseIfQuarantined,
  refuseIfRateLimited,
  LinkContainmentRefusal,
  LinkRateRefusal
} from './orchestration-link-binding-pending'
import { FEDERATED_SEND_RATE_LIMIT } from '../../orchestration/link-binding-constants'
import { getRoutableLinkBinding } from '../../orchestration/link-binding-routable'
import { resolveForeignThread } from './orchestration-federated-peer-send-inbound'

const FederatedSendParams = z.object({
  // Optional (D3): an old sender, or one whose pane has no registered `agents` row, omits it.
  fromAgent: FederatedSenderIdentitySchema.optional(),
  toAgentId: requiredString('Missing target agent id'),
  messageId: requiredString('Missing relayed message id'),
  threadId: OptionalString,
  // S10-16 R20.1: optional, sent only behind ORCHESTRATION_LINK_BINDING_RUNTIME_CAPABILITY on
  // the SENDER's side — this receiver runs the detector whenever the field is present.
  inReplyToMessageId: OptionalString,
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
  authorshipUnconfirmed?: true
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
        // R27.2 (Ruling 23 Addendum 3): rate -> containment -> identity shape -> recipient. The
        // one caller class already decided hostile must not have an unbounded call rate either.
        refuseIfRateLimited(runtime, pairedDeviceId, 'federatedSend', FEDERATED_SEND_RATE_LIMIT)
        // R3 (Ruling 23 Addendum 2(n)): link containment before identity — a quarantined link
        // refuses BEFORE the identity importer runs, effect-free, on peer_link_containment alone
        // (no peer-supplied value in the read). Same gate, same order as the probe/confirm RPCs.
        refuseIfQuarantined(runtime, pairedDeviceId, 'send')

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

        if (!isHostMessageId(params.messageId)) {
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
        requireOptionalThreadId(params.threadId, 'thread id')
        const inReplyToMessageId =
          params.inReplyToMessageId === undefined
            ? undefined
            : requireHostMessageId(params.inReplyToMessageId, 'in-reply-to message id')
        // Idempotent replay vs conflict (mirrors importFederatedRelayItem's conflict rule,
        // db.ts): a peer-chosen id that already exists on this host either matches (a retry —
        // return the stored receipt) or conflicts (refuse). Finding 21: this distinction is a
        // 48-bit existence oracle for an arbitrary msg_* id; accepted as designed (2^48 makes
        // enumeration impractical) and stated here per the Gate-1 justification.
        const existing = db.getMessageById(params.messageId)
        if (existing) {
          // S10-16 R17.2 (v5, P8): the replay predicate is LINK-scoped, and a re-pair on the
          // RECEIVING side must not turn an already-delivered reply into `request_mismatch`.
          // `getRoutableLinkBinding` — ROUTABLE rows only (P8) — on both links; matching key
          // fingerprints under a live, unrevoked, unquarantined binding of THIS host's own
          // proving means "the same runtime, by INV-P-008", purely local.
          const sameOriginHost = (storedLink: string | null, callerLink: string): boolean => {
            if (storedLink === null) {
              return false
            }
            if (storedLink === callerLink) {
              return true
            }
            const a = getRoutableLinkBinding(db, runtime, storedLink)
            const b = getRoutableLinkBinding(db, runtime, callerLink)
            return a !== null && b !== null && a.peerKeyFingerprint === b.peerKeyFingerprint
          }
          // S10-15 review m-1: R7 step 2 also required matching `type` — without it, a real id
          // collision with a DIFFERENT type (e.g. a genuine msg_* clash presenting a different
          // message shape under the same id) was silently swallowed as an idempotent "accepted"
          // replay instead of refusing request_mismatch.
          if (
            existing.to_handle === `agent:${toAgent.id}` &&
            sameOriginHost(existing.peer_link_device_id ?? null, pairedDeviceId) &&
            existing.type === (params.type ?? 'status')
          ) {
            // R13.1: an authenticated inbound call is proof of liveness — after admission
            // (a replay is still an admitted call), never before. Ruling 23(j)/FC-1: clamps
            // next_attempt_after only, never resets consecutive_failures.
            runtime.getLinkBindingProver().scheduleBinding(pairedDeviceId, 'inbound_contact')
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

        // S10-16 R28.1/R20.1: resolved BEFORE insertGatedMessage — a local thread for every
        // foreign-origin row, and the authorship predicate (L5: a failed lookup still stores).
        const { threadId: resolvedThreadId, authorshipUnconfirmed } = resolveForeignThread(
          db,
          runtime,
          {
            toAgent,
            askerHandle,
            pairedDeviceId,
            inReplyToMessageId,
            peerThreadId: params.threadId ?? null,
            subject: params.subject,
            body: params.body
          }
        )

        const inserted = db.insertGatedMessage({
          id: params.messageId,
          from: askerHandle,
          to: `agent:${toAgent.id}`,
          subject: params.subject,
          body: params.body,
          type: (params.type ?? 'status') as MessageType,
          priority: params.priority,
          // R28: the LOCAL thread this host minted or resolved above — the peer's own id is
          // never written to `messages.thread_id`; it lives in peer_thread_id below.
          threadId: resolvedThreadId,
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
        db.bumpThreadOnMessage(resolvedThreadId, message)
        runtime.notifyMessageArrived(
          message.to_handle,
          message.type,
          message.thread_id,
          extractPayloadKind(message.payload_kind)
        )
        // R13.1: an authenticated inbound call is proof of liveness — tail of the handler,
        // after the mail has been fully admitted. Ruling 23(j)/FC-1: clamps next_attempt_after
        // only, never resets consecutive_failures.
        runtime.getLinkBindingProver().scheduleBinding(pairedDeviceId, 'inbound_contact')
        return {
          accepted: true,
          messageId: message.id,
          threadId: message.thread_id,
          ...(authorshipUnconfirmed ? { authorshipUnconfirmed: true as const } : {})
        } satisfies FederatedSendResult
      } catch (error) {
        // C3a delta D2 — see the identical exclusion in orchestration-federated-peer-ask.ts's own
        // catch for the full rationale: exclude by ORIGIN (the marked `LinkContainmentRefusal`
        // from `refuseIfQuarantined`, which already wrote its own metered audit row per D3), never
        // by code alone — a quarantined-SENDER refusal from federated-sender-identity.ts is a
        // plain `OrchestrationError` with the same `agent_quarantined` code and must still reach
        // this audit write every time.
        if (
          error instanceof OrchestrationError &&
          !(error instanceof LinkContainmentRefusal) &&
          !(error instanceof LinkRateRefusal)
        ) {
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
