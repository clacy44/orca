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
import { clampOrchestrationAskTimeoutMs } from '../../../../shared/orchestration-ask-timeout'
import {
  sanitizeDirectoryText,
  sanitizeRole,
  validateDisplayNameCandidate
} from '../../orchestration/agent-name-sanitizer'

// Mirrors agents-cross-host.ts's FOREIGN_AGENT_ID_RE / FOREIGN_TERMINAL_HANDLE_MAX_LENGTH: a
// peer-supplied id is re-emitted verbatim into this host's own thread/message rows (the
// synthetic `remote:<link>:<id>` from-handle below), so it must match the only shape a genuine
// directory id can have — anything else is refused, never rendered or stored.
const FOREIGN_AGENT_ID_RE = /^agt_[0-9a-f]{12}$/
const FOREIGN_HOST_LABEL_MAX_LENGTH = 128

// S10-8 review fix (blocker: agents-cross-host.ts's LOCAL_FIND_HOST sentinel, duplicated here —
// same reasoning as orchestration.ts's own LOCAL_PEER_HOST): a peer-asserted `host` of exactly
// this string is indistinguishable from "this host's own name" to anything that later renders
// it, so it is never stored verbatim (falls back to the link's own device id instead, same as
// an empty host).
const LOCAL_PEER_HOST_SENTINEL = 'local'

const FederatedAskParams = z.object({
  fromAgent: z.object({
    id: requiredString('Missing sender agent id'),
    displayName: requiredString('Missing sender display name'),
    role: z.string().nullable().optional(),
    // Self-reported label for the asker's own environment — display/provenance only (S10-4
    // TRUST BOUNDARY: peer self-report, unverifiable here, forever). Namespacing stays
    // receiver-relative; this is never treated as one of THIS host's own environment names.
    host: z.string().optional(),
    // S10-8 review fix (blocker: quarantine crosses the link): the origin host's own assertion
    // that this caller is currently quarantined there — carried so the receiver can refuse
    // independently of relayPeerAskToHost's own pre-relay check (defense in depth, never the
    // only guard: a hostile/buggy peer could always send `false`).
    quarantined: z.boolean().optional()
  }),
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
        // R3: recipient resolution honors every existing guard (unknown/quarantined/derived) —
        // never a second, looser copy of the local rule for a foreign asker.
        const toAgent = requireAddressableAgentRecipient(db, params.toAgentId)
        toAgentIdForAudit = toAgent.id

        if (!FOREIGN_AGENT_ID_RE.test(params.fromAgent.id)) {
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
        // S10-8 review fix (blocker: peer-controlled identity collides with the local
        // namespace): a peer that claims a LOCAL agent's own id must never be trusted — S10-4
        // ruling 1 keeps foreign claims out of the `agents` id namespace specifically so a
        // remote_agents row can never be mistaken for (or shadow) a real local one. Also closes
        // a self-relay loop: a runtime relaying into itself presents an id this same check
        // already owns locally.
        if (db.getAgentById(params.fromAgent.id)) {
          throw new OrchestrationError(
            'invalid_argument',
            'The relayed sender id collides with an agent already registered on this host.',
            {
              nextSteps: [
                'verify the paired link is a genuine remote peer, not a loop back to this same host'
              ]
            }
          )
        }
        const displayNameCandidate = sanitizeDirectoryText(params.fromAgent.displayName, 80).value
        if (!displayNameCandidate || !validateDisplayNameCandidate(displayNameCandidate).ok) {
          throw new OrchestrationError(
            'invalid_argument',
            'The relayed sender display name is not addressable.',
            {
              nextSteps: [
                'this indicates a version-mismatched or malformed peer relay — update Orca on the asking host'
              ]
            }
          )
        }
        const role = sanitizeRole(params.fromAgent.role ?? null)?.value ?? null
        const hostLabelCandidate = params.fromAgent.host
          ? sanitizeDirectoryText(params.fromAgent.host, FOREIGN_HOST_LABEL_MAX_LENGTH).value
          : ''
        // S10-8 review fix (major: peer picks its own host label): a self-reported label of
        // exactly the local sentinel is never stored verbatim — see LOCAL_PEER_HOST_SENTINEL.
        const hostLabel =
          hostLabelCandidate.toLowerCase() === LOCAL_PEER_HOST_SENTINEL ? '' : hostLabelCandidate
        // Why `pairedDeviceId` as the remote_agents key, not a KnownRuntimeEnvironment.id: this
        // host was called INTO, so it has no saved environment of its own for the caller — only
        // the stable per-link device identity the pairing/socket layer already resolved. It
        // satisfies the same invariant the column protects (uniquely names "which link"); a real
        // environment-id linkage needs an explicit link/consent step (full S10-4c), out of scope
        // here (R6). Documented as a deviation in the S10-8 report.
        db.upsertRemoteAgent({
          environmentId: pairedDeviceId,
          environmentName: hostLabel || pairedDeviceId,
          remoteAgentId: params.fromAgent.id,
          displayName: displayNameCandidate,
          role,
          state: 'live',
          derived: false,
          // S10-8 review fix (blocker: quarantine crosses the link): the origin host's own
          // assertion, carried in the envelope — never hardcoded false. A remote-asserted LIFT
          // is still fenced by trg_remote_lift_scope (db.ts), so this can never clear a local
          // defensive quarantine on its own.
          remoteQuarantined: params.fromAgent.quarantined === true
        })
        const remoteRow = db
          .listRemoteAgents({ environmentId: pairedDeviceId, includeQuarantined: true })
          .find((row) => row.remote_agent_id === params.fromAgent.id)
        if (remoteRow?.local_quarantined) {
          throw new OrchestrationError(
            'agent_quarantined',
            `${displayNameCandidate}@${hostLabel || pairedDeviceId} is quarantined on this host and cannot ask.`,
            {
              nextSteps: [
                `this host quarantined ${displayNameCandidate}@${hostLabel || pairedDeviceId} after an earlier contact`,
                'orca agents list --all-hosts'
              ]
            }
          )
        }
        if (remoteRow?.remote_quarantined) {
          throw new OrchestrationError(
            'agent_quarantined',
            `${displayNameCandidate}@${hostLabel || pairedDeviceId} is quarantined on its origin host and cannot ask.`,
            {
              nextSteps: [
                `${displayNameCandidate} is quarantined on its own host — lift it there with "orca agents quarantine ${displayNameCandidate} --lift"`
              ]
            }
          )
        }

        timeoutMs = clampOrchestrationAskTimeoutMs(params.timeoutMs)
        // R3: the sender's directory identity so a reply can address `name@origin-host` — never a
        // local `agent:<id>` handle, so it can never collide with, or be mistaken for, a locally
        // registered agent (agent-name-sanitizer's DISPLAY_NAME_PATTERN already refuses `:`/`@`
        // in a real display name, so this synthetic prefix can never be produced by a local row).
        const askerHandle = `remote:${pairedDeviceId}:${params.fromAgent.id}`
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
          infraAllowlist: []
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
      } catch (error) {
        if (error instanceof OrchestrationError) {
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
          // Same close-on-give-up as the abort branch above.
          db.closeQuestionsForDispatch(`peer:${threadId}`)
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
