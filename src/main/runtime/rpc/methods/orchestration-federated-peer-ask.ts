// S10-8 R2/R3: the receiving half of cross-host peer ask relay. `orchestration.federatedAsk` is
// called ONLY server-to-server, over the same paired-link transport the dispatch relay and
// `agents list --all-hosts` probes already use (`callOrchestrationWorkerServer` /
// `orchestrationEnvironmentTransport`) — never by a local pane, and never by an old CLI (params
// shape differs from `orchestration.ask`). Its caller is authenticated as "a genuine paired
// runtime" (R2: "the link does the authentication"); WHO on that runtime is asking is self-
// reported in `fromAgent` and trusted only as far as S10-4's TRUST BOUNDARY already trusts any
// peer self-report — never as a bindable local identity.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { PEER_RUN_ID, isUnauthenticatedLaneCallerFingerprint } from '../../orchestration/db'
import { requireAddressableAgentRecipient } from '../../orchestration/addressable-agent-recipient'
import { gateVerdictRefusalError } from '../../orchestration/gate-refusal-error'
import { deriveThreadSubject } from '../../../../shared/thread-subject'
import { extractPayloadKind } from '../../orchestration/message-waiter-thread-keying'
import {
  clampOrchestrationAskTimeoutMs,
  ORCHESTRATION_ASK_MAX_TIMEOUT_MS
} from '../../../../shared/orchestration-ask-timeout'
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
import { FEDERATED_ASK_RATE_LIMIT } from '../../orchestration/link-binding-constants'

// S10-15 F5 (chair ruling 5): the per-link cap on PENDING relayed questions.
const PEER_ASK_PENDING_CAP = 32
// S10-15 F5 (chair ruling 5, findings 5/13): a bounded grace window past the asker's own
// timeout during which this host still holds the question open rather than closing it
// immediately — findings 5/13's fix, replacing Design A R10's unbounded-pending removal of the
// close-on-timeout. Bounded, not removed: a peer can still only accumulate PEER_ASK_PENDING_CAP
// of these per link at any moment.
const RESUME_GRACE_MS = 10 * 60 * 1000

const FederatedAskParams = z.object({
  fromAgent: FederatedSenderIdentitySchema,
  toAgentId: requiredString('Missing target agent id'),
  question: requiredString('Missing question'),
  options: z.array(z.string()).optional(),
  timeoutMs: OptionalFiniteNumber
})

type FederatedAskResult = {
  answer: string | null
  messageId: string
  answerMessageId?: string | null
  threadId: string
  timedOut: boolean
  cancelled?: boolean
  connectionLost?: boolean
  timeoutMs: number
}

export const ORCHESTRATION_FEDERATED_PEER_ASK_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.federatedAsk',
    params: FederatedAskParams,
    handler: async (
      params,
      { runtime, signal, authenticatedCallerFingerprint, pairedDeviceId, clientKind }
    ) => {
      const db = runtime.getOrchestrationDb()
      // S10-8 review fix (blocker: no audit row / no nextSteps on a relayed refusal): every
      // refusal below is a disposition a paired peer can otherwise probe for free with zero
      // forensic trace (agent_unknown vs agent_quarantined vs derived_agent_unaddressable
      // differentiate this host's directory over the link). One choke point — catch, audit,
      // rethrow — so no future refusal branch can be added here without one. `toAgentIdForAudit`
      // is filled in as soon as the recipient resolves; audits before that carry `null` (the
      // failure happened before there was a local agent to attribute it to).
      let toAgentIdForAudit: string | null = null
      // Definite-assignment: every path out of the try block below either assigns these before
      // falling through, or throws (caught and rethrown) — never reached uninitialized.
      let questionId!: string
      let threadId!: string
      let waitAddress!: string
      let timeoutMs!: number
      try {
        // R2: "the link does the authentication (peer fingerprint — 'authenticated_transport'
        // fallback must never qualify)". A genuine paired runtime always carries both; refusing
        // whichever is missing keeps this from ever being satisfiable by an unattested local
        // caller (the CLI, the renderer) guessing at the method name.
        if (
          !pairedDeviceId ||
          clientKind !== 'runtime' ||
          isUnauthenticatedLaneCallerFingerprint(authenticatedCallerFingerprint)
        ) {
          throw new OrchestrationError(
            'unauthenticated_lane',
            'Cross-host ask requires an authenticated paired-runtime link, not a local caller.',
            {
              nextSteps: [
                'this call must arrive over a paired runtime link, never a local pane or an old CLI — re-pair the two hosts if this persists'
              ]
            }
          )
        }
        // R27.1/R27.2 (Ruling 23 Addendum 3): rate -> containment -> identity shape -> recipient.
        refuseIfRateLimited(runtime, pairedDeviceId, 'federatedAsk', FEDERATED_ASK_RATE_LIMIT)
        // R3 (Ruling 23 Addendum 2(n)): link containment before identity — a quarantined link
        // refuses BEFORE the identity importer runs, effect-free, on peer_link_containment alone
        // (no peer-supplied value in the read). Same gate, same order as the probe/confirm RPCs.
        refuseIfQuarantined(runtime, pairedDeviceId, 'ask')

        // R3: recipient resolution honors every existing guard (unknown/quarantined/derived) —
        // never a second, looser copy of the local rule for a foreign asker.
        const toAgent = requireAddressableAgentRecipient(db, params.toAgentId)
        toAgentIdForAudit = toAgent.id

        // D2: the shared importer (federated-sender-identity.ts) runs the id-shape check, the
        // local-collision refusal, display-name validation, the fingerprint<->link binding
        // (ruling 2) and per-link cap (ruling 3b) checks, and the upsert-then-quarantine-reread
        // — in that exact load-bearing order — and never throws. This ask path adapts the result
        // back into today's byte-identical throw shape; `absent` is unreachable here because
        // `fromAgent` stays required on federatedAsk (only the future relayed-send method makes
        // it optional, with D3's deliver-on-invalid policy).
        const imported = importFederatedSenderIdentity(db, {
          identity: params.fromAgent,
          linkKey: pairedDeviceId,
          peerFingerprint: authenticatedCallerFingerprint as string
        })
        if (
          imported.outcome === 'invalid' ||
          imported.outcome === 'quarantined' ||
          imported.outcome === 'fingerprint_conflict'
        ) {
          throw imported.error
        }
        if (imported.outcome === 'absent') {
          throw new OrchestrationError(
            'invalid_argument',
            'The relayed sender id is not a valid agent directory id.',
            {
              nextSteps: [
                'this indicates a version-mismatched or malformed peer relay — update Orca on the asking host'
              ]
            }
          )
        }
        // `imported.outcome` is now 'imported' | 'capped' — both carry displayName/hostLabel/
        // askerHandle; 'capped' (ruling 3b) never blocks the ask itself, only the mirror write.
        const { askerHandle } = imported

        // S10-15 review F3: `expiresAt` below is Ruling 5's actual bound (this ask's OWN
        // clamped timeoutMs + RESUME_GRACE_MS) — clamp first so the sweep, the cap check, and
        // the mint all see the same value.
        timeoutMs = clampOrchestrationAskTimeoutMs(params.timeoutMs)
        const expiresAt = new Date(Date.now() + timeoutMs + RESUME_GRACE_MS).toISOString()

        // S10-15 review B-1/F3: a time-deferred close inside the blocking-wait loop below can
        // never observe elapsed time past `deadline` (waitForMessage/the loop return AT the
        // deadline, never after it) — so closing has to happen as a lazy sweep at the next
        // ingest instead. Run it BEFORE the cap check so an expired link's rows are reclaimed
        // before they can wedge a new ask against the cap. `nowIso` sweeps every row whose OWN
        // per-ask `expires_at` has passed; `fallbackThresholdIso` (max-clamp+grace) only ever
        // matches a pre-F3 row with no `expires_at` of its own.
        db.closeExpiredPeerQuestionsForLink(
          pairedDeviceId,
          new Date().toISOString(),
          new Date(Date.now() - (ORCHESTRATION_ASK_MAX_TIMEOUT_MS + RESUME_GRACE_MS)).toISOString()
        )

        // S10-15 F5 (chair ruling 5): a per-link cap on PENDING questions — independent of the
        // remote_agents mirror cap (ruling 3b) — so a peer cannot mint unbounded pending
        // question_threads/threads/messages rows by relaying asks that time out (finding 5's
        // hazard). Refused before any row is minted.
        // S10-15 review F3: no dedicated capacity/too-many/limit passthrough code exists in
        // errors.ts (grepped) — keeping invalid_argument, stated here per the finding's own
        // instruction not to mint a new code for this.
        if (db.countPendingPeerQuestionsForLink(pairedDeviceId) >= PEER_ASK_PENDING_CAP) {
          throw new OrchestrationError(
            'invalid_argument',
            `This link already has ${PEER_ASK_PENDING_CAP} pending cross-host questions; answer or let them expire (closed automatically after they age past their timeout) before asking more.`,
            {
              nextSteps: [
                'wait for pending questions on this link to be answered or to age out and close automatically'
              ]
            }
          )
        }

        const { thread } = db.createThread({
          subject: deriveThreadSubject({ body: params.question }),
          createdByAgentId: null,
          origin: 'question',
          participants: [
            { participantKey: askerHandle, agentId: null, handle: askerHandle, role: 'owner' },
            {
              participantKey: toAgent.id,
              agentId: toAgent.id,
              handle: toAgent.terminal_handle,
              role: 'member'
            }
          ]
        })
        const created = db.createPeerQuestion({
          runId: PEER_RUN_ID,
          threadId: thread.id,
          askerHandle,
          toAgentId: toAgent.id,
          toHandle: `agent:${toAgent.id}`,
          question: params.question,
          options: params.options ?? [],
          // R3 standing inbound rule: a local infra literal never blocks mail a remote peer
          // already sent — h3 does not run on the import path (mirrors importFederatedRelayItem).
          infraAllowlist: [],
          expiresAt
        })
        if (created.outcome === 'refused') {
          // Gate refusal already wrote its own durable audit row (gate_refusals) inside
          // insertGatedMessage — this throw is what becomes the delivery-status R7 expects back
          // on the asking host, not a silent drop (also caught below for the generic trail).
          throw gateVerdictRefusalError(created.verdict, created.refusalId)
        }
        const question = created.question
        questionId = question.message_id
        threadId = question.thread_key ?? questionId
        waitAddress = askerHandle
        db.bumpThreadOnMessage(thread.id, created.message)
        // Pushes the recipient's own pane on receipt (S10-4 §WAKE) — the sender never touches it.
        runtime.notifyMessageArrived(
          created.message.to_handle,
          created.message.type,
          created.message.thread_id,
          extractPayloadKind(created.message.payload_kind)
        )
        // R13.1: an authenticated inbound call is proof of liveness — after the ask has been
        // fully admitted (never before), and before the blocking wait below. Ruling 23(j)/FC-1:
        // clamps next_attempt_after only, never resets consecutive_failures.
        runtime.getLinkBindingProver().scheduleBinding(pairedDeviceId, 'inbound_contact')
      } catch (error) {
        // C3a delta D2: exclude by ORIGIN, not by code. `refuseIfQuarantined` throws the marked
        // `LinkContainmentRefusal` subclass and already handles its own audit write under its own
        // per-window meter (D3) — this choke point must not duplicate it. But an `agent_quarantined`
        // thrown from INSIDE this handler for a different reason — a quarantined RECIPIENT
        // (addressable-agent-recipient.ts) — is a plain `OrchestrationError`, not the marker, and
        // must still reach this audit write every time (it was silently dropped by the old
        // code-based exclusion, which could not tell the two apart).
        if (
          error instanceof OrchestrationError &&
          !(error instanceof LinkContainmentRefusal) &&
          !(error instanceof LinkRateRefusal)
        ) {
          db.writeAgentAudit({
            agentId: toAgentIdForAudit,
            actorPaneKey: null,
            actorHostId: pairedDeviceId ?? null,
            verb: 'federatedAsk',
            outcome: error.code,
            reasonCode: null
          })
        }
        throw error
      }
      const deadline = Date.now() + timeoutMs
      while (true) {
        const current = db.getQuestion(questionId)
        if (!current || current.status === 'closed') {
          throw new OrchestrationError('dispatch_inactive', `Question ${questionId} closed.`)
        }
        if (current.status === 'answered') {
          const result: FederatedAskResult = {
            answer: current.answer_body,
            messageId: questionId,
            answerMessageId: current.answer_message_id,
            threadId,
            timedOut: false,
            cancelled: false,
            connectionLost: false,
            timeoutMs
          }
          return result
        }
        if (signal?.aborted) {
          // S10-8 review fix (major: R4 reply routing silently dropped outside the blocking
          // window): cross-host has no resume (R6 fence — unlike a local peer ask, this question
          // can never be waited on again), so leaving it 'pending' forever only invites an
          // answer nobody will ever see and an unbounded pile of orphans on retry. Closing it
          // makes a subsequent `orchestration.reply` refuse with the existing `dispatch_inactive`
          // typed disposition (answerPeerQuestion's `outcome: 'closed'` branch) instead of
          // silently succeeding into the void.
          db.closeQuestionsForDispatch(`peer:${threadId}`)
          const result: FederatedAskResult = {
            answer: null,
            messageId: questionId,
            threadId,
            timedOut: false,
            cancelled: true,
            connectionLost: true,
            timeoutMs
          }
          return result
        }
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          // S10-15 review B-1: the asker's own blocking call returns `timedOut: true` at its
          // requested deadline (never held open past what it asked for) — this handler cannot
          // itself observe RESUME_GRACE_MS elapsing (it returns now, at the deadline). The
          // question stays `pending` so a late answer arriving inside the grace window still
          // lands; `closeExpiredPeerQuestionsForLink` (run at the top of every ask on this link,
          // above) is what actually closes it once it ages past timeoutMs + RESUME_GRACE_MS.
          // Bounded, never unbounded, in the meantime: PEER_ASK_PENDING_CAP caps how many such
          // rows a link can hold open at once regardless of how long any one of them lingers.
          const result: FederatedAskResult = {
            answer: null,
            messageId: questionId,
            threadId,
            timedOut: true,
            cancelled: false,
            connectionLost: false,
            timeoutMs
          }
          return result
        }
        await runtime.waitForMessage(waitAddress, { timeoutMs: remainingMs, signal })
      }
    }
  })
]
