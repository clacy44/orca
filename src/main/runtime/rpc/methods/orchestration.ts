/* eslint-disable max-lines -- Why: RPC method definitions co-locate param schemas with handlers; splitting by method would scatter the shared enums and Zod transforms without reducing complexity. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, OptionalBoolean, requiredString } from '../schemas'
import {
  LEGACY_CONTRACT_VERSION,
  PEER_RUN_ID,
  type MessageType,
  type MessagePriority,
  type OrchestrationDb,
  type TaskStatus
} from '../../orchestration/db'
import {
  MESSAGE_TYPES,
  type MessageRow,
  type QuestionRow,
  type RunRow
} from '../../orchestration/types'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { formatMessageBanner } from '../../orchestration/formatter'
import { isGroupAddress, resolveGroupAddress } from '../../orchestration/groups'
import { isBarePeerHandle } from '../../orchestration/stale-handle-resolution'
import { reconcileLifecycleMessage } from '../../orchestration/lifecycle-reconciliation'
import { waitForFederatedLifecycleSettlement } from '../../orchestration/federation-lifecycle-settlement'
import { abbreviateOrchestrationTasks } from '../../../../shared/orchestration-task-summary'
import {
  ORCHESTRATION_LEGACY_RUN_ID,
  orchestrationSkillRecoveryData
} from '../../../../shared/orchestration-rpc-contract'
import { clampOrchestrationAskTimeoutMs } from '../../../../shared/orchestration-ask-timeout'
import { ORCHESTRATION_GATE_METHODS } from './orchestration-gates'
import { resolveRunScope } from './orchestration-run-scope'
import {
  assertRemoteRunMailboxCaller,
  isRemoteRunMailboxRequest,
  resolveRemoteRunMailboxScope
} from './orchestration-remote-run-mailbox'
import { ORCHESTRATION_RUN_METHODS } from './orchestration-runs'
import { ORCHESTRATION_AGENT_METHODS } from './orchestration-agents'
import { ORCHESTRATION_WORKER_METHODS } from './orchestration-worker-methods'
import { ORCHESTRATION_FEDERATION_METHODS } from './orchestration-federation-methods'
import { ORCHESTRATION_SENT_METHODS } from './orchestration-sent'
import { ORCHESTRATION_THREAD_METHODS, resolveThreadReplay } from './orchestration-thread'
import { ORCHESTRATION_CONTAINMENT_METHODS } from './orchestration-containment'
import { ORCHESTRATION_THREADS_METHODS } from './orchestration-threads'
import { ORCHESTRATION_WAIT_METHODS } from './orchestration-wait'
import {
  assertThreadNotSensitiveForBroadcast,
  assertThreadNotSensitiveForFederation
} from './orchestration-sensitive-thread-guard'
import { ORCHESTRATION_PACT_METHODS } from './orchestration-pact'
import { ORCHESTRATION_PACT_STEP_METHODS } from './orchestration-pact-step'
import { ORCHESTRATION_THREAD_INVITE_METHODS } from './orchestration-thread-invite'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  NO_PANE_IDENTITY_NEXT_STEPS,
  NO_REGISTERED_IDENTITY_NEXT_STEPS,
  resolveCallerAgent
} from './orchestration-caller-identity'
import { buildFederatedSenderIdentity } from '../../orchestration/federated-sender-identity'
import { requireAddressableAgentRecipient } from '../../orchestration/addressable-agent-recipient'
import { ORCHESTRATION_FEDERATED_PEER_ASK_METHODS } from './orchestration-federated-peer-ask'
import {
  assertPayloadKindNotCallerSet,
  extractPayloadKind
} from '../../orchestration/message-waiter-thread-keying'
import { gateVerdictRefusalError } from '../../orchestration/gate-refusal-error'
import { payloadValueForGate } from '../../orchestration/message-gate-writer'
import { deriveThreadSubject } from '../../../../shared/thread-subject'
import type { OrchestrationCompatibilityEvidence } from '../../../../shared/orchestration-compatibility-evidence'
import { requireActiveDispatchForWorkerMail } from '../../orchestration/dispatch-mail-fence'
import { whileDispatchBlocked } from '../../orchestration/dispatch-blocked-window'
import { requireFederatedDispatchAcceptsWorkerMail } from '../../orchestration/federation-worker-mail-fence'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { encodeFederatedControlMessage } from '../../orchestration/federation-control-message'
import {
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'

const TASK_STATUSES: TaskStatus[] = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
]

function getLifecycleGroupRecipientError(type: 'worker_done' | 'heartbeat'): string {
  return `${type} messages belong to one exact Dispatch and cannot target a group address.`
}

function parseRemoteWorkerPayload(payload: string | undefined): Record<string, unknown> {
  if (!payload) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    throw new OrchestrationError('invalid_argument', 'Message payload must be valid JSON.')
  }
}

function isWorkerReportOutcome(value: unknown): value is 'succeeded' | 'failed' {
  return value === 'succeeded' || value === 'failed'
}

const SendParams = z
  .object({
    to: OptionalString,
    subject: requiredString('Missing --subject'),
    from: OptionalString,
    body: OptionalString,
    type: z
      .enum([
        'status',
        'dispatch',
        'worker_done',
        'merge_ready',
        'escalation',
        'handoff',
        'decision_gate',
        'question',
        'heartbeat'
      ])
      .optional(),
    priority: z.enum(['normal', 'high', 'urgent']).optional(),
    threadId: OptionalString,
    payload: OptionalString,
    // Why: pane key is the remint-stable identity used to verify worker_done/heartbeat ownership; the from handle stays routing metadata.
    senderPaneKey: OptionalString,
    run: OptionalString,
    waitForLifecycleSettlement: OptionalBoolean,
    // Why: capability-negotiated opt-in; see orchestration-remote-run-mailbox.ts.
    remoteRunMailbox: OptionalBoolean,
    devMode: OptionalBoolean,
    // GATE § escape hatch: converts a HARD verdict into a stored-and-flagged send rather than
    // refusing outright (message-gate-writer.ts InsertGatedMessageParams.acknowledgeGate).
    acknowledgeGate: OptionalBoolean
  })
  .superRefine((params, ctx) => {
    if (
      (params.type !== 'worker_done' && params.type !== 'heartbeat') ||
      !params.to ||
      !isGroupAddress(params.to)
    ) {
      return
    }
    // Why: dispatch lifecycle messages are authority/liveness signals for one coordinator; fanout would create lifecycle mail in unrelated terminals.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: getLifecycleGroupRecipientError(params.type),
      path: ['to']
    })
  })

const CheckParams = z
  .object({
    terminal: OptionalString,
    terminalPaneKey: OptionalString,
    unread: OptionalBoolean,
    peek: OptionalBoolean,
    // Why: `all` surfaces every message and skips mark-read; legacy encoding was the `{unread: false}` trick (design doc §3.2/§3.3).
    all: OptionalBoolean,
    types: OptionalString,
    format: OptionalBoolean,
    // Why: one-release RPC compatibility only; the public CLI uses --format because no terminal input is injected.
    inject: OptionalBoolean,
    ack: OptionalString,
    // Why optional and mailbox-scoped (owner decision 3, dual behaviour): the NEW `agent:<id>`
    // mailbox is always implicit/durable regardless of this param. The existing `dispatch:` and
    // bare-handle mailboxes default to today's destructive markAsRead-on-read when this is
    // absent/'destructive' — zero regression for in-flight callers — and opt into the same
    // replay-until-ack durability as `agent:<id>` only when the caller sends 'implicit'.
    ackMode: z.enum(['implicit', 'destructive']).optional(),
    compatibilityAck: OptionalString,
    compatibilityQuestionAck: OptionalString,
    compatibilityCliCommand: z.enum(['orca', 'orca-ide', 'orca-dev']).optional(),
    run: OptionalString,
    remoteRunMailbox: OptionalBoolean,
    wait: OptionalBoolean,
    timeoutMs: OptionalFiniteNumber
  })
  .superRefine((params, ctx) => {
    // Why: CLI encodes --peek as {peek:true, unread:false} for pre-peek runtimes, so that pair is one mode, not a conflict.
    const modes = [
      params.unread === true,
      params.peek === true,
      params.all === true || (params.unread === false && params.peek !== true)
    ].filter(Boolean)
    if (modes.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose at most one message read mode: --unread, --peek, or --all.'
      })
    }
  })

const ReplyParams = z.object({
  id: requiredString('Missing --id'),
  body: requiredString('Missing --body'),
  from: OptionalString,
  run: OptionalString,
  remoteRunMailbox: OptionalBoolean,
  acknowledgeGate: OptionalBoolean
})

const InboxParams = z.object({
  limit: OptionalFiniteNumber,
  // Why: filters the inbox to a handle so inbox and check --all give agreeing results (design doc §3.3).
  terminal: OptionalString,
  // Why it wins over --terminal (BUG 4): a thread is cross-participant, so filtering it further to
  // one handle would silently drop the other side of the same conversation.
  threadId: OptionalString
})

const TaskCreateParams = z.object({
  spec: requiredString('Missing --spec'),
  taskTitle: OptionalString,
  displayName: OptionalString,
  deps: OptionalString,
  parent: OptionalString,
  callerTerminalHandle: OptionalString,
  run: OptionalString
})

const TaskListParams = z.object({
  status: z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']).optional(),
  ready: OptionalBoolean,
  // Why: server-side truncation keeps --brief cheap over SSH/relay instead of shipping full specs the CLI throws away.
  brief: OptionalBoolean,
  run: OptionalString,
  callerTerminalHandle: OptionalString
})

const TaskUpdateParams = z.object({
  id: requiredString('Missing --id'),
  status: z
    .unknown()
    .transform((v) => {
      if (typeof v === 'string' && TASK_STATUSES.includes(v as TaskStatus)) {
        return v as TaskStatus
      }
      return ''
    })
    .pipe(
      z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'], {
        message: 'Missing --status'
      })
    ),
  result: OptionalString,
  run: OptionalString,
  callerTerminalHandle: OptionalString
})

const DispatchParams = z.object({
  task: requiredString('Missing --task'),
  // Why: --to is optional so --dry-run can preview without a target; the handler enforces presence before any side-effecting work.
  to: OptionalString,
  from: OptionalString,
  inject: OptionalBoolean,
  dryRun: OptionalBoolean,
  returnPreamble: OptionalBoolean,
  devMode: OptionalBoolean,
  run: OptionalString
})

const DispatchShowParams = z.object({
  task: OptionalString,
  preamble: OptionalBoolean,
  from: OptionalString,
  devMode: OptionalBoolean
})

const AskParams = z
  .object({
    to: OptionalString,
    question: OptionalString,
    resume: OptionalString,
    options: OptionalString,
    timeoutMs: OptionalFiniteNumber,
    from: OptionalString,
    run: OptionalString,
    compatibilityCliCommand: z.enum(['orca', 'orca-ide', 'orca-dev']).optional(),
    compatibilityWindowsCommand: z.enum(['orca', 'orca-ide']).optional(),
    acknowledgeGate: OptionalBoolean,
    // S10-8 R1: set only when `to` names a foreign agent (`name@host` resolved CLI-side) — the
    // saved-environment selector to relay this ask to. Never opens a second client; see
    // relayPeerAskToHost below. A new optional field on an existing envelope, so an old CLI (or
    // one talking to an old runtime that ignores it) degrades to today's local-only behavior.
    host: OptionalString
  })
  .superRefine((params, ctx) => {
    if ((params.question ? 1 : 0) + (params.resume ? 1 : 0) !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose exactly one of --question or --resume.'
      })
    }
  })

const ResetParams = z
  .object({
    all: OptionalBoolean,
    tasks: OptionalBoolean,
    messages: OptionalBoolean
  })
  .superRefine((params, ctx) => {
    const selectedScopeCount = [params.all, params.tasks, params.messages].filter(
      (scope) => scope === true
    ).length
    if (selectedScopeCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose exactly one reset scope: --all, --tasks, or --messages.'
      })
    }
  })

function parseMessageTypes(rawTypes: string | undefined): MessageType[] | undefined {
  const types = rawTypes
    ?.split(',')
    .map((type) => type.trim())
    .filter(Boolean) as MessageType[] | undefined
  const invalidTypes = types?.filter((type) => !MESSAGE_TYPES.includes(type))
  if (invalidTypes && invalidTypes.length > 0) {
    throw new OrchestrationError('invalid_argument', `Invalid --types: ${invalidTypes.join(',')}`)
  }
  return types && types.length > 0 ? types : undefined
}

// BUG 5, generalized: replay-until-`--ack` delivery over `mailbox_deliveries`, shared by the
// `agent:<id>`, `dispatch:<id>` (ackMode:'implicit') and bare-handle (ackMode:'implicit') check
// branches. Legacy rows (ORCHESTRATION_LEGACY_RUN_ID) are reported as `legacyPending`, never
// thrown at the caller and never included in the delivery — the fence's intent, generalized past
// the `agent:` mailbox it originally shipped on (A4/ROUTING).
function readMailboxDelivery(
  db: OrchestrationDb,
  params: { mailboxHandle: string; fetchCandidates: () => MessageRow[]; ack?: string }
): {
  legacyPending: number
  deliveryId: string | null
  messages: MessageRow[]
  replayed: boolean
  pendingBehind: number
  acknowledged: string | null
  // Amendment E fix (adversarial review major #5): db.getOrCreateMailboxDelivery already
  // computes this (message-visibility-filter.ts, via fetchMessagesByIds) — it was being
  // dropped on the floor here, so every check call site through this helper had no way to
  // report a purged/quarantine-withheld row at all.
  omitted?: { purged: number; withheld: number }
} {
  // Why ack BEFORE fetching candidates, not after: acknowledging marks the prior delivery's
  // frozen ids `read`. A candidate query run before the ack would still see those ids as
  // unread and hand them straight back into the newly-minted delivery — the message would
  // never actually clear. (This is exactly what broke when a first draft of this helper took
  // a pre-computed `candidates` array instead of fetching after the ack.)
  const acknowledged = params.ack
    ? db.acknowledgeMailboxDelivery(params.ack, params.mailboxHandle)
    : undefined
  const candidates = params.fetchCandidates()
  const legacyPending = candidates.filter(
    (row) => row.run_id === ORCHESTRATION_LEGACY_RUN_ID
  ).length
  const candidateIds = candidates
    .filter((row) => row.run_id !== ORCHESTRATION_LEGACY_RUN_ID)
    .map((row) => row.id)
  const current = db.getOrCreateMailboxDelivery({
    mailboxHandle: params.mailboxHandle,
    messageIds: candidateIds,
    limit: 50
  })
  return {
    legacyPending,
    deliveryId: current?.delivery.id ?? null,
    messages: current?.messages ?? [],
    replayed: current?.replayed ?? false,
    pendingBehind: current?.pendingBehind ?? 0,
    acknowledged: acknowledged?.delivery.id ?? null,
    ...(current?.omitted ? { omitted: current.omitted } : {})
  }
}

// Amendment E fix (adversarial review major #5): the omission counts readMailboxDelivery now
// carries through were computed but never surfaced in the `--format`/`--inject` text either —
// a piped/injected caller had no way to see them at all, JSON or text.
function formatOmittedMessagesLine(omitted?: { purged: number; withheld: number }): string {
  if (!omitted || (omitted.purged === 0 && omitted.withheld === 0)) {
    return ''
  }
  const parts: string[] = []
  if (omitted.purged > 0) {
    parts.push(`${omitted.purged} purged`)
  }
  if (omitted.withheld > 0) {
    parts.push(`${omitted.withheld} withheld (author quarantined)`)
  }
  return `[${parts.join(', ')} — omitted from this delivery]`
}

function appendOmittedMessagesLine(
  formatted: string,
  omitted?: { purged: number; withheld: number }
): string {
  const line = formatOmittedMessagesLine(omitted)
  return line ? [formatted, line].filter(Boolean).join('\n\n') : formatted
}

// Why: an ambient pane notice can be lost on hosts whose PTY write path never lands, so the
// worker's own heartbeat reply is the beat that can still tell it coordinator mail is waiting.
// Zero is omitted, not sent: the field is additive and optional, and a "0 unread" line on every
// heartbeat would train workers to skip it.
function pendingDispatchMail(
  db: OrchestrationDb,
  params: { dispatchId: string | undefined; senderPaneKey: string | null | undefined }
): { pendingMail?: number } {
  if (!params.dispatchId) {
    return {}
  }
  // Why silent for a run-bound pane: `check` takes the Run branch first and never reads the
  // dispatch mailbox, so hinting at unread mail would send that worker to "No messages."
  if (params.senderPaneKey && db.getCurrentRunForPane(params.senderPaneKey)) {
    return {}
  }
  const count = db.countUnreadMessages(`dispatch:${params.dispatchId}`)
  return count > 0 ? { pendingMail: count } : {}
}

function resolveMessageRun(
  runtime: OrcaRuntimeService,
  params: {
    from?: string
    senderPaneKey?: string
    to?: string
    runId?: string
    payload?: string
    // Why: a paired caller's handle names a pane on ITS runtime, so guessing a local Run from it would misdeliver.
    allowPaneFallback?: boolean
  }
): { run: RunRow | undefined; dispatchId: string | undefined } {
  const db = runtime.getOrchestrationDb()
  let dispatchId: string | undefined
  if (params.payload) {
    try {
      const payload: unknown = JSON.parse(params.payload)
      if (
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        typeof (payload as { dispatchId?: unknown }).dispatchId === 'string'
      ) {
        dispatchId = (payload as { dispatchId: string }).dispatchId
      }
    } catch {
      // Lifecycle validation owns malformed payload errors; routing simply cannot derive a Dispatch.
    }
  }
  if (!dispatchId && params.to?.startsWith('dispatch:')) {
    dispatchId = params.to.slice('dispatch:'.length)
  }

  const dispatch = dispatchId
    ? db.getDispatchContextById(dispatchId)
    : params.from
      ? db.getActiveDispatchForIdentity(params.from, params.senderPaneKey)
      : undefined
  if (params.to?.startsWith('dispatch:') && !dispatch) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Dispatch ${dispatchId ?? ''} was not found.`
    )
  }
  const targetRunId = params.to?.startsWith('run:') ? params.to.slice('run:'.length) : undefined
  const resolvedRunId = params.runId ?? targetRunId ?? dispatch?.run_id
  let run = resolvedRunId ? db.getRun(resolvedRunId) : undefined

  if (!run && params.from && params.allowPaneFallback !== false) {
    const paneKey = params.senderPaneKey ?? runtime.getTerminalPaneKey(params.from)
    run = paneKey ? db.getCurrentRunForPane(paneKey) : undefined
  }
  if (resolvedRunId && (!run || run.legacy === 1)) {
    throw new OrchestrationError('run_not_found', `Run ${resolvedRunId} was not found.`)
  }
  if (run && targetRunId && targetRunId !== run.id) {
    throw new OrchestrationError('run_not_found', `Run ${targetRunId} was not found.`)
  }
  if (run && dispatch && dispatch.run_id !== run.id) {
    throw new OrchestrationError(
      'dispatch_run_mismatch',
      `Dispatch ${dispatch.id} belongs to Run ${dispatch.run_id}, not ${run.id}.`
    )
  }
  return { run, dispatchId: dispatch?.id ?? dispatchId }
}

function legacyWorkerDeliveryContract(
  runtime: OrcaRuntimeService,
  runId: string | undefined,
  recipient: string
): 'legacy_direct' | undefined {
  if (!runId) {
    return undefined
  }
  if (!recipient.startsWith('dispatch:')) {
    return runtime
      .getOrchestrationDb()
      .resolveLegacyWorkerCandidate({ runId, terminalHandle: recipient })
      ? 'legacy_direct'
      : undefined
  }
  const dispatch = runtime
    .getOrchestrationDb()
    .getDispatchContextById(recipient.slice('dispatch:'.length))
  return dispatch?.run_id === runId &&
    dispatch.contract_version === LEGACY_CONTRACT_VERSION &&
    (dispatch.status === 'pending' || dispatch.status === 'dispatched')
    ? 'legacy_direct'
    : undefined
}

function interruptedAcknowledgedCheck(
  runId: string,
  acknowledged: string,
  reason: 'consumer_fenced' | 'outcome_unknown' | 'waiter_exists'
): Record<string, unknown> {
  return {
    runId,
    deliveryId: null,
    messages: [],
    count: 0,
    acknowledged,
    timedOut: false,
    cancelled: false,
    connectionLost: false,
    waitInterrupted: reason
  }
}

function rejectFederatedExplicitTarget(params: { to?: string; run?: string }): void {
  if (params.to || params.run) {
    throw new OrchestrationError(
      'invalid_argument',
      'Federated Dispatch messages route to their Run home; omit --to and --run.'
    )
  }
}

export const ORCHESTRATION_METHODS: RpcMethod[] = [
  ...ORCHESTRATION_RUN_METHODS,
  ...ORCHESTRATION_AGENT_METHODS,
  ...ORCHESTRATION_WORKER_METHODS,
  ...ORCHESTRATION_FEDERATION_METHODS,
  ...ORCHESTRATION_SENT_METHODS,
  ...ORCHESTRATION_THREAD_METHODS,
  ...ORCHESTRATION_CONTAINMENT_METHODS,
  ...ORCHESTRATION_THREADS_METHODS,
  ...ORCHESTRATION_WAIT_METHODS,
  ...ORCHESTRATION_PACT_METHODS,
  ...ORCHESTRATION_PACT_STEP_METHODS,
  ...ORCHESTRATION_THREAD_INVITE_METHODS,
  ...ORCHESTRATION_FEDERATED_PEER_ASK_METHODS,
  defineMethod({
    name: 'orchestration.send',
    params: SendParams,
    handler: async (
      params,
      {
        runtime,
        orchestrationCapability,
        legacyCoordinatorRunId,
        revalidateLegacyCoordinator,
        orchestrationCompatibilityCallerAuthority,
        pairedDeviceId,
        clientKind,
        signal
      }
    ) => {
      const db = runtime.getOrchestrationDb()
      // Why first (K25, blocker fix): every branch below (point-to-point, group fan-out, and
      // both federation relay directions) forwards params.payload verbatim — one guard at the
      // single entry closes the forgery for all of them at once.
      assertPayloadKindNotCallerSet(params.payload)
      const remoteRunMailbox = {
        remoteRunMailbox: params.remoteRunMailbox,
        pairedDeviceId,
        clientKind
      }
      if (isRemoteRunMailboxRequest(remoteRunMailbox)) {
        assertRemoteRunMailboxCaller(remoteRunMailbox)
        if (!params.to && !params.run) {
          throw new OrchestrationError(
            'invalid_argument',
            'Cross-runtime mail needs an explicit recipient: --to run:<id> or --run <id>.'
          )
        }
      }
      const from = params.from ?? 'unknown'
      const attestedCaller =
        orchestrationCompatibilityCallerAuthority?.terminalHandle === from
          ? orchestrationCompatibilityCallerAuthority
          : undefined
      // Why: attested hook identity survives graph remount; caller params never supply lifecycle
      // authority. Adversarial review major #4 fix: the `getTerminalPaneKey(from)` fallback used
      // to run unconditionally, so a caller attested as one pane (orchestrationCompatibilityCallerAuthority
      // present, just for a DIFFERENT handle than params.from) could still get params.from's real
      // pane — and its real sender_agent_id — resolved and stamped, impersonating that identity
      // in the pane pointer and escaping quarantine/purge scoping that key off sender_agent_id.
      // A caller that proved no attestation at all keeps today's unauthenticated-fallback
      // behavior (`getTerminalPaneKey(from)`, same as before); a caller that proved attestation
      // for a DIFFERENT handle than it's claiming as `from` gets that disagreeing claim ignored
      // instead — ends up with no resolved pane, same as an unregistered sender.
      const senderPaneKey = attestedCaller
        ? attestedCaller.paneKey
        : orchestrationCompatibilityCallerAuthority
          ? undefined
          : (runtime.getTerminalPaneKey(from) ?? undefined)
      // Why hoisted here (not just the point-to-point branch below): the host id is author
      // provenance on EVERY send — point-to-point and group fan-out alike
      // (messages.sender_agent_id, resolved by insertGatedMessage itself from senderPaneKey —
      // including the "null for a quarantined sender" guard, message-gate-writer.ts).
      const senderHostId = runtime.getOrchestrationCompatibilityHostId() ?? 'local'
      const remoteAttachment = senderPaneKey
        ? db.findActiveRemoteAttachmentForPane(senderPaneKey)
        : undefined
      if (remoteAttachment) {
        rejectFederatedExplicitTarget(params)
        const processIncarnation =
          attestedCaller?.processIncarnation ?? runtime.getTerminalProcessIncarnation(from)
        if (
          !db.verifyRemoteAttachmentAuthority({
            dispatchId: remoteAttachment.dispatch_id,
            capability: orchestrationCapability,
            paneKey: senderPaneKey ?? null,
            processIncarnation
          })
        ) {
          throw new OrchestrationError(
            'dispatch_capability_invalid',
            'The remote Dispatch capability or exact worker process is invalid.'
          )
        }
        const type = (params.type ?? 'status') as MessageType
        const payload = parseRemoteWorkerPayload(params.payload)
        if (
          typeof payload.dispatchId === 'string' &&
          payload.dispatchId !== remoteAttachment.dispatch_id
        ) {
          throw new OrchestrationError(
            'dispatch_inactive',
            `Dispatch ${payload.dispatchId} is not the active remote Dispatch for this pane.`
          )
        }
        const outcome =
          type === 'worker_done' &&
          (payload.outcome === 'succeeded' || payload.outcome === 'failed')
            ? payload.outcome
            : undefined
        if (type === 'worker_done' && !outcome) {
          throw new OrchestrationError(
            'invalid_argument',
            'Remote worker_done requires outcome=succeeded|failed.'
          )
        }
        const supportsLifecycleSettlement =
          remoteAttachment.protocol_version >=
          ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
        assertThreadNotSensitiveForFederation(db, params.threadId)
        const relay = db.enqueueFederationRelay({
          dispatchId: remoteAttachment.dispatch_id,
          direction: 'to_home',
          kind: type,
          payload: JSON.stringify({
            from,
            subject: params.subject,
            body: params.body ?? '',
            type,
            priority: params.priority ?? 'normal',
            threadId: params.threadId ?? null,
            payload: params.payload ?? null
          }),
          ...(!supportsLifecycleSettlement && outcome ? { settleRemoteOutcome: outcome } : {})
        })
        const lifecycle =
          outcome && supportsLifecycleSettlement
            ? await waitForFederatedLifecycleSettlement(
                runtime,
                relay.dispatch_id,
                relay.sequence,
                {
                  timeoutMs: 30_000,
                  signal
                }
              )
            : outcome
              ? {
                  action: outcome === 'succeeded' ? ('completed' as const) : ('failed' as const),
                  authority: 'worker_server_legacy' as const
                }
              : undefined
        if (outcome && supportsLifecycleSettlement && !lifecycle) {
          throw new OrchestrationError(
            'operation_unknown',
            'worker_done was queued, but the Run-home runtime did not confirm settlement. Verify the Task and Dispatch before retrying.'
          )
        }
        return {
          relay: {
            messageId: relay.message_id,
            sequence: relay.sequence,
            dispatchId: relay.dispatch_id,
            destination: 'run_home',
            accepted: true
          },
          ...(lifecycle ? { lifecycle } : {}),
          // Why: imported coordinator control mail lands in this peer's own dispatch mailbox, so the count is local.
          ...(type === 'heartbeat'
            ? pendingDispatchMail(db, {
                dispatchId: remoteAttachment.dispatch_id,
                senderPaneKey
              })
            : {})
        }
      }
      const routing = resolveMessageRun(runtime, {
        from,
        senderPaneKey,
        to: params.to,
        runId: params.run,
        payload: params.payload,
        allowPaneFallback: !isRemoteRunMailboxRequest(remoteRunMailbox)
      })
      if (
        params.type === 'worker_done' &&
        !isWorkerReportOutcome(parseRemoteWorkerPayload(params.payload).outcome)
      ) {
        throw new OrchestrationError(
          'invalid_argument',
          'worker_done requires outcome=succeeded|failed for a current Dispatch.'
        )
      }
      if (params.to?.startsWith('task:')) {
        throw new OrchestrationError(
          'invalid_argument',
          'Task recipients are intentionally unsupported; use run:<id> or dispatch:<id>.'
        )
      }
      let to = params.to
      if (
        routing.run &&
        (!to ||
          ((params.type === 'worker_done' || params.type === 'heartbeat') && routing.dispatchId))
      ) {
        to = `run:${routing.run.id}`
      }
      if (!to) {
        throw new OrchestrationError(
          'run_required',
          'No recipient or active Dispatch Run could be resolved. No effects were applied.',
          orchestrationSkillRecoveryData()
        )
      }

      if (!isGroupAddress(to)) {
        const federatedDispatchId = routing.dispatchId
        const federatedTarget =
          federatedDispatchId && to === `dispatch:${federatedDispatchId}`
            ? db.getFederatedDispatch(federatedDispatchId)
            : undefined
        if (federatedTarget && federatedDispatchId) {
          const dispatchId = federatedDispatchId
          if (
            federatedTarget.protocol_version <
            ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
          ) {
            throw new OrchestrationError(
              'capability_unsupported',
              `Federated Dispatch ${dispatchId} does not support coordinator control mail; start a fresh worker after updating its Orca server.`
            )
          }
          requireFederatedDispatchAcceptsWorkerMail(db, dispatchId)
          if (params.type === 'worker_done' || params.type === 'heartbeat') {
            throw new OrchestrationError(
              'invalid_argument',
              'Coordinator-to-worker control mail cannot report worker lifecycle.'
            )
          }
          revalidateLegacyCoordinator?.()
          assertThreadNotSensitiveForFederation(db, params.threadId)
          const relay = db.enqueueFederationRelay({
            dispatchId,
            direction: 'to_worker',
            kind: 'control_message',
            payload: encodeFederatedControlMessage({
              from,
              subject: params.subject,
              body: params.body ?? '',
              type: (params.type ?? 'status') as MessageType,
              priority: (params.priority ?? 'normal') as MessagePriority,
              threadId: params.threadId ?? null,
              payload: params.payload ?? null
            })
          })
          runtime.ensureOrchestrationFederationRelay(routing.run?.id)
          return {
            relay: {
              messageId: relay.message_id,
              sequence: relay.sequence,
              dispatchId: relay.dispatch_id,
              destination: 'worker',
              accepted: true
            }
          }
        }
        if (to.startsWith('dispatch:')) {
          requireActiveDispatchForWorkerMail(db, to.slice('dispatch:'.length))
        }
        // Why (A4/ROUTING): `agent:<id>` is a directory address, not a terminal
        // handle — resolve it here so an unknown/quarantined recipient refuses
        // before insertMessage, and so the row lands on PEER_RUN_ID instead of
        // silently defaulting to LEGACY_RUN_ID (which would throw on the
        // recipient's `check`, db.ts:2928).
        let agentRecipient: ReturnType<typeof db.getAgentById>
        if (to.startsWith('agent:')) {
          agentRecipient = requireAddressableAgentRecipient(db, to.slice('agent:'.length))
        }
        // Point-to-point — existing single-recipient behavior
        revalidateLegacyCoordinator?.()
        // Why: a bare peer handle has no mailbox row to fall back through on a
        // later graph reload (BUG 6) — record its pane key now so the ambient
        // push can re-resolve it once the handle goes stale.
        const isBareHandleTarget = isBarePeerHandle(to)
        const recipientPaneKey = agentRecipient
          ? (agentRecipient.pane_key ?? undefined)
          : isBareHandleTarget
            ? (runtime.getTerminalPaneKey(to) ?? undefined)
            : undefined
        // Send-side thread minting (S10-2b deferral, ruling 8): a peer-to-agent send with no
        // explicit --thread-id lands the pair in a real thread automatically — reusing their
        // live 1:1 if one exists — so wait/pact never require a separate threads.create round
        // trip first. Scoped to genuine peer traffic: agent:<id> targets only, never a Dispatch
        // lifecycle report (worker_done/heartbeat use their own dispatch: mailbox threading).
        let mintedThreadId: string | undefined
        let threadCreated = false
        if (
          !params.threadId &&
          agentRecipient &&
          params.type !== 'worker_done' &&
          params.type !== 'heartbeat'
        ) {
          const senderAgentId = senderPaneKey
            ? db.getAgentByPaneKey(senderHostId, senderPaneKey)?.id
            : undefined
          if (senderAgentId) {
            const minted = db.findOrCreatePeerThread({
              agentAId: senderAgentId,
              agentBId: agentRecipient.id,
              subjectHint: params.subject ?? null
            })
            mintedThreadId = minted.thread.id
            threadCreated = minted.created
          }
        }
        // Amendment A: db.insertGatedMessage is the single write choke for point-to-point send
        // (ruling 2) — never db.insertMessage directly.
        const inserted = db.insertGatedMessage({
          from,
          to,
          subject: params.subject,
          body: params.body,
          type: params.type as MessageType,
          priority: params.priority as MessagePriority,
          threadId: params.threadId ?? mintedThreadId,
          payload: payloadValueForGate(params.payload),
          senderPaneKey,
          recipientPaneKey,
          senderHostId,
          // Why (A4/BUG 6, generalized to bare-handle peers): with no bound Run, a bare
          // terminal-handle send between two hand-started agents defaults to LEGACY_RUN_ID
          // (db.ts insertMessage) exactly like an `agent:<id>` send would — and the
          // recipient's `check` fences that with `legacy_read_only`. PEER_RUN_ID is the
          // fix for both address shapes; only a genuine dispatch:/run: mailbox is left to
          // its own routing (agentRecipient and isBareHandleTarget are both false there).
          runId:
            routing.run?.id ?? (agentRecipient || isBareHandleTarget ? PEER_RUN_ID : undefined),
          deliveryContract: legacyWorkerDeliveryContract(
            runtime,
            routing.run?.id ?? legacyCoordinatorRunId,
            to
          ),
          acknowledgeGate: params.acknowledgeGate,
          verb: 'send'
        })
        if (inserted.outcome === 'refused') {
          throw gateVerdictRefusalError(inserted.verdict, inserted.refusalId)
        }
        const msg = inserted.message
        if (mintedThreadId) {
          db.bumpThreadOnMessage(mintedThreadId, msg)
        }
        const dispatch = routing.dispatchId
          ? db.getDispatchContextById(routing.dispatchId)
          : undefined
        if ((msg.type === 'worker_done' || msg.type === 'heartbeat') && dispatch?.capability_hash) {
          const authority = db.verifyDispatchCapability({
            dispatchId: dispatch.id,
            capability: orchestrationCapability,
            paneKey: senderPaneKey,
            processIncarnation:
              attestedCaller?.processIncarnation ??
              runtime.getTerminalProcessIncarnation(from) ??
              undefined
          })
          if (!authority.valid) {
            const rejection =
              db.convertLifecycleMessageToRejection(
                msg.id,
                'dispatch_capability_invalid',
                authority.reason
              ) ?? msg
            runtime.notifyMessageArrived(
              to,
              rejection.type,
              rejection.thread_id,
              extractPayloadKind(rejection.payload_kind)
            )
            return {
              message: rejection,
              lifecycle: {
                action: 'rejected',
                code: 'dispatch_capability_invalid',
                reason: authority.reason
              }
            }
          }
        }
        // Why: reconcile releases the dispatch lock before waking recipients, else a woken coordinator re-dispatches while the lock is still held.
        if (msg.type === 'worker_done' || msg.type === 'heartbeat') {
          // Why: read before reconcile so a heartbeat reports the mailbox the worker is about to poll, not one mutated by settlement.
          const pendingMail =
            msg.type === 'heartbeat'
              ? pendingDispatchMail(db, {
                  dispatchId: db.getActiveDispatchForIdentity(from, senderPaneKey)?.id,
                  senderPaneKey
                })
              : {}
          const reconciled = reconcileLifecycleMessage(db, msg)
          // Why: a suppressed message is already read, so skip the notify that would wake a check --wait waiter to an empty result.
          if (reconciled.action === 'suppressed') {
            // Why keep pendingMail: a CLI that predates the verdict still prints the receipt this
            // hint rides on, and dropping a field an old client reads is a wire change (Rule 3).
            // A current CLI raises the verdict before printing, so the field is inert there.
            return {
              message: msg,
              lifecycle: {
                action: 'suppressed',
                dispatchId: reconciled.dispatchId,
                reason: 'Dispatch is no longer active.'
              },
              ...pendingMail
            }
          }
          if (reconciled.action === 'rejected') {
            const rejection = db.getMessageById(msg.id) ?? msg
            runtime.notifyMessageArrived(
              to,
              rejection.type,
              rejection.thread_id,
              extractPayloadKind(rejection.payload_kind)
            )
            return { message: rejection, lifecycle: reconciled }
          }
          runtime.notifyMessageArrived(
            to,
            msg.type,
            msg.thread_id,
            extractPayloadKind(msg.payload_kind)
          )
          return msg.type === 'worker_done'
            ? { message: msg, lifecycle: reconciled }
            : { message: msg, ...pendingMail }
        }
        runtime.notifyMessageArrived(
          to,
          msg.type,
          msg.thread_id,
          extractPayloadKind(msg.payload_kind)
        )
        // threadId/threadCreated/gateFlags are additive — present only when this send actually
        // resolved or minted a thread (mintedThreadId) or an explicit --thread-id was already
        // live on the row; absent for the untouched legacy no-thread path.
        return {
          message: msg,
          ...(msg.thread_id
            ? {
                threadId: msg.thread_id,
                threadCreated,
                gateFlags: msg.gate_flags ? (JSON.parse(msg.gate_flags) as string[]) : null
              }
            : {})
        }
      }

      // Why: fan out one message per recipient (independent read-tracking) but share a thread_id for correlation (Section 4.5).
      const { terminals } = await runtime.listTerminals(undefined, undefined, {
        includeVisualLayouts: false
      })
      const handles = resolveGroupAddress(to, from, terminals, (handle: string) =>
        runtime.getAgentStatusForHandle(handle)
      )

      if (handles.length === 0) {
        throw new Error(`No recipients resolved for group address: ${to}`)
      }

      revalidateLegacyCoordinator?.()
      assertThreadNotSensitiveForBroadcast(db, params.threadId)
      const threadId = params.threadId ?? `thread_${Date.now()}`
      // Amendment A: fan-out/broadcast routes through the single write choke too (ruling 2).
      // Gated once, before expansion (SENSITIVE THREADS §'s "a blocked body is blocked for all
      // N recipients") — the first recipient's verdict decides the whole batch, so a HARD
      // refusal inserts zero rows for any of the N handles rather than the first K.
      const messages: MessageRow[] = []
      for (const handle of handles) {
        const inserted = db.insertGatedMessage({
          from,
          to: handle,
          subject: params.subject,
          body: params.body,
          type: params.type as MessageType,
          priority: params.priority as MessagePriority,
          threadId,
          payload: payloadValueForGate(params.payload),
          senderPaneKey,
          senderHostId,
          // Why: group addresses resolve to bare peer handles (BUG 6) — same
          // durable pane-key recording as the point-to-point path above.
          recipientPaneKey: runtime.getTerminalPaneKey(handle) ?? undefined,
          runId: routing.run?.id,
          deliveryContract: legacyWorkerDeliveryContract(
            runtime,
            routing.run?.id ?? legacyCoordinatorRunId,
            handle
          ),
          acknowledgeGate: params.acknowledgeGate,
          verb: 'send'
        })
        if (inserted.outcome === 'refused') {
          throw gateVerdictRefusalError(inserted.verdict, inserted.refusalId)
        }
        messages.push(inserted.message)
      }
      for (const message of messages) {
        runtime.notifyMessageArrived(
          message.to_handle,
          message.type,
          message.thread_id,
          extractPayloadKind(message.payload_kind)
        )
      }

      return { messages, recipients: handles.length }
    }
  }),

  defineMethod({
    name: 'orchestration.check',
    params: CheckParams,
    handler: async (
      params,
      {
        orchestrationCompatibilityEvidence,
        runtime,
        signal,
        legacyCoordinatorRunId,
        revalidateLegacyCoordinator,
        recordMutationReceipt,
        pairedDeviceId,
        clientKind
      }
    ) => {
      const db = runtime.getOrchestrationDb()
      const handle = params.terminal ?? 'unknown'
      const typeFilter = parseMessageTypes(params.types)

      // Why: a live runtime handle is authoritative; pane metadata is only the restart fallback.
      const paneKey = runtime.getTerminalPaneKey(handle) ?? params.terminalPaneKey
      const boundRun = paneKey ? db.getCurrentRunForPane(paneKey) : undefined
      if (params.run || boundRun) {
        const run = resolveRemoteRunMailboxScope(
          runtime,
          {
            runId: params.run,
            callerTerminalHandle: handle,
            callerPaneKey: paneKey ?? undefined,
            requireCurrentConsumer: true,
            legacyCoordinatorRunId,
            callerEvidence: orchestrationCompatibilityEvidence
          },
          { remoteRunMailbox: params.remoteRunMailbox, pairedDeviceId, clientKind }
        )
        const generation = run.consumer_generation
        const address = `run:${run.id}`
        runtime.ensureOrchestrationFederationRelay(run.id)

        const acknowledged = params.ack
          ? db.acknowledgeRunDelivery({
              runId: run.id,
              consumerGeneration: generation,
              deliveryId: params.ack
            })
          : undefined
        if (acknowledged) {
          recordMutationReceipt?.(
            interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'outcome_unknown')
          )
        }
        if (params.peek || params.all || params.unread === false) {
          const history = db.getRunMailboxHistory(run.id, 100, typeFilter)
          const messages =
            params.all || (params.unread === false && !params.peek)
              ? history
              : history.filter((message) => message.read === 0)
          const result = {
            messages,
            count: messages.length,
            acknowledged: acknowledged?.delivery.id ?? null
          }
          if (params.format || params.inject) {
            return {
              ...result,
              formatted: messages.map(formatMessageBanner).join('\n\n'),
              runId: run.id
            }
          }
          return { ...result, runId: run.id }
        }

        const readDelivery = (wakeTypes?: MessageType[]) =>
          db.getOrCreateRunDelivery({
            runId: run.id,
            consumerGeneration: generation,
            wakeTypes
          })
        let current = readDelivery(params.wait ? typeFilter : undefined)
        if (current) {
          return {
            runId: run.id,
            deliveryId: current.delivery.id,
            messages: current.messages,
            count: current.messages.length,
            replayed: current.replayed,
            pendingBehind: current.pendingBehind,
            acknowledged: acknowledged?.delivery.id ?? null,
            timedOut: false,
            cancelled: false,
            connectionLost: false,
            ...(params.format || params.inject
              ? { formatted: current.messages.map(formatMessageBanner).join('\n\n') }
              : {})
          }
        }
        if (!params.wait) {
          return {
            runId: run.id,
            deliveryId: null,
            messages: [],
            count: 0,
            acknowledged: acknowledged?.delivery.id ?? null,
            timedOut: false,
            cancelled: false,
            connectionLost: false
          }
        }

        const waitResult = await runtime.waitForMessage(address, {
          typeFilter: typeFilter as string[] | undefined,
          timeoutMs: params.timeoutMs ?? undefined,
          signal,
          exclusive: true
        })
        try {
          revalidateLegacyCoordinator?.()
        } catch (error) {
          if (!acknowledged) {
            throw error
          }
          return interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'consumer_fenced')
        }
        const latestRun = db.getRun(run.id)
        if (!latestRun || latestRun.consumer_generation !== generation) {
          if (acknowledged) {
            return interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'consumer_fenced')
          }
          throw new OrchestrationError(
            'consumer_fenced',
            'This mailbox consumer was replaced while waiting.'
          )
        }
        if (waitResult === 'waiter_exists') {
          if (acknowledged) {
            return interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'waiter_exists')
          }
          throw new OrchestrationError(
            'waiter_exists',
            `Run ${run.id} already has an active actionable waiter.`
          )
        }
        if (waitResult === 'timed_out') {
          return {
            runId: run.id,
            deliveryId: null,
            messages: [],
            count: 0,
            acknowledged: acknowledged?.delivery.id ?? null,
            timedOut: true,
            cancelled: false,
            connectionLost: false
          }
        }
        if (waitResult === 'cancelled') {
          return {
            runId: run.id,
            deliveryId: null,
            messages: [],
            count: 0,
            acknowledged: acknowledged?.delivery.id ?? null,
            timedOut: false,
            cancelled: true,
            connectionLost: signal?.aborted === true
          }
        }

        current = readDelivery(typeFilter)
        return {
          runId: run.id,
          deliveryId: current?.delivery.id ?? null,
          messages: current?.messages ?? [],
          count: current?.messages.length ?? 0,
          replayed: current?.replayed ?? false,
          pendingBehind: current?.pendingBehind ?? 0,
          acknowledged: acknowledged?.delivery.id ?? null,
          timedOut: false,
          cancelled: false,
          connectionLost: false,
          ...(params.format && current
            ? { formatted: current.messages.map(formatMessageBanner).join('\n\n') }
            : {})
        }
      }

      const activeDispatch = db.getActiveDispatchForIdentity(handle, paneKey ?? undefined)
      const remoteAttachment =
        !activeDispatch && paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
      if (
        remoteAttachment &&
        !db.isRemoteAttachmentProcessCurrent({
          dispatchId: remoteAttachment.dispatch_id,
          paneKey: paneKey ?? null,
          processIncarnation: runtime.getTerminalProcessIncarnation(handle)
        })
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${remoteAttachment.dispatch_id} is no longer attached to this worker process.`
        )
      }
      const workerMailbox = activeDispatch
        ? { dispatchId: activeDispatch.id, runId: activeDispatch.run_id }
        : remoteAttachment
          ? { dispatchId: remoteAttachment.dispatch_id, runId: undefined }
          : undefined
      if (workerMailbox) {
        const address = `dispatch:${workerMailbox.dispatchId}`
        const showAll = params.all === true || (params.unread === false && params.peek !== true)
        const consumeUnread = !showAll && params.peek !== true
        // Why the dual path (owner decision 3): default stays today's destructive markAsRead —
        // zero regression for in-flight callers. ackMode:'implicit' opts this dispatch: mailbox
        // into the same replay-until-ack durability agent:<id> ships with (BUG 5). Why the
        // candidate query is INSIDE the implicit branch and not hoisted above it: an ack must
        // mark the prior delivery's ids read before this query runs, or it would still see
        // them as unread and hand the just-acked batch straight back (readMailboxDelivery
        // enforces this ordering internally via `fetchCandidates`).
        let messages: MessageRow[]
        let deliveryMeta: Record<string, unknown> = {}
        let deliveryOmitted: { purged: number; withheld: number } | undefined
        if (consumeUnread && params.ackMode === 'implicit') {
          const durable = readMailboxDelivery(db, {
            mailboxHandle: address,
            fetchCandidates: () => db.getUnreadMessages(address, typeFilter),
            ack: params.ack
          })
          messages = durable.messages
          deliveryOmitted = durable.omitted
          deliveryMeta = {
            deliveryId: durable.deliveryId,
            replayed: durable.replayed,
            pendingBehind: durable.pendingBehind,
            acknowledged: durable.acknowledged,
            ...(durable.omitted ? { omitted: durable.omitted } : {})
          }
        } else {
          messages = showAll
            ? db.getAllMessagesForHandle(address, 100, typeFilter)
            : db.getUnreadMessages(address, typeFilter)
          if (consumeUnread && messages.length > 0) {
            db.markAsRead(messages.map((message) => message.id))
          }
        }
        if (messages.length > 0 || !params.wait) {
          return {
            ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
            dispatchId: workerMailbox.dispatchId,
            messages,
            count: messages.length,
            ...deliveryMeta,
            ...(params.format || params.inject
              ? {
                  formatted: appendOmittedMessagesLine(
                    messages.map(formatMessageBanner).join('\n\n'),
                    deliveryOmitted
                  )
                }
              : {})
          }
        }
        // Why here and not at the top of the branch: everything above returns without parking —
        // --peek, --all and a mailbox that already had mail are reads, and the preamble exempts
        // only a worker actually blocked inside the call (A1 §14).
        const waitResult = await whileDispatchBlocked(db, workerMailbox.dispatchId, () =>
          runtime.waitForMessage(address, {
            typeFilter: typeFilter as string[] | undefined,
            timeoutMs: params.timeoutMs ?? undefined,
            signal
          })
        )
        if (waitResult === 'timed_out' || waitResult === 'cancelled') {
          return {
            ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
            dispatchId: workerMailbox.dispatchId,
            messages: [],
            count: 0,
            timedOut: waitResult === 'timed_out',
            cancelled: waitResult === 'cancelled',
            connectionLost: waitResult === 'cancelled' && signal?.aborted === true
          }
        }
        let arrived: MessageRow[]
        let arrivedDeliveryMeta: Record<string, unknown> = {}
        let arrivedOmitted: { purged: number; withheld: number } | undefined
        if (params.ackMode === 'implicit') {
          const durable = readMailboxDelivery(db, {
            mailboxHandle: address,
            fetchCandidates: () => db.getUnreadMessages(address, typeFilter),
            ack: params.ack
          })
          arrived = durable.messages
          arrivedOmitted = durable.omitted
          arrivedDeliveryMeta = {
            deliveryId: durable.deliveryId,
            replayed: durable.replayed,
            pendingBehind: durable.pendingBehind,
            acknowledged: durable.acknowledged,
            ...(durable.omitted ? { omitted: durable.omitted } : {})
          }
        } else {
          arrived = db.getUnreadMessages(address, typeFilter)
          db.markAsRead(arrived.map((message) => message.id))
        }
        return {
          ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
          dispatchId: workerMailbox.dispatchId,
          messages: arrived,
          count: arrived.length,
          ...arrivedDeliveryMeta,
          ...(params.format || params.inject
            ? {
                formatted: appendOmittedMessagesLine(
                  arrived.map(formatMessageBanner).join('\n\n'),
                  arrivedOmitted
                )
              }
            : {})
        }
      }

      // Why (S10-1 ROUTING "Check"): the caller's own directory row, if any, owns
      // an `agent:<id>` mailbox — durable via mailbox_deliveries (BUG 5), taken
      // before the bare-handle branch below so a registered agent's mail never
      // falls through to the legacy-fenced path.
      // Identity here is ONLY runtime.verifyOrchestrationCompatibilityCaller — never a
      // caller-supplied `--terminal`/`terminalPaneKey`. `orchestrationCompatibilityCallerAuthority`
      // (the legacy-adoption preflight) is undefined for an ordinary peer, so it cannot be a
      // fallback source of identity here; this branch verifies directly instead (ARBITRATION A1,
      // CONTAINMENT #1 — mirrors agents.register/find/quarantine's own direct verify call).
      const agentHostId = runtime.getOrchestrationCompatibilityHostId() ?? 'local'
      const attestedForAgentCheck = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence,
        { currentRuntimeLaunchSufficient: true }
      )
      const callerAgentRow =
        attestedForAgentCheck && attestedForAgentCheck.terminalHandle === handle
          ? db.getAgentByPaneKey(agentHostId, attestedForAgentCheck.paneKey)
          : undefined
      // Why derived !== 1: a derived row is minted by ANY caller's `agents list`/`find` for
      // every live pane (agent-directory-rpc-liveness.ts) — the pane's own owner never opted
      // in. Routing a never-registered pane through the durable agent: branch would silently
      // flip its pre-existing bare-handle mailbox from destructive to replay-until-ack a
      // release early (owner decision 3) merely because a third party listed the directory.
      if (callerAgentRow && !callerAgentRow.tombstoned_at && callerAgentRow.derived !== 1) {
        // Safe: callerAgentRow is only ever set (above) when attestedForAgentCheck is truthy.
        const attestedProcessIncarnation = attestedForAgentCheck?.processIncarnation
        const address = `agent:${callerAgentRow.id}`
        db.refreshAgentLiveness({
          id: callerAgentRow.id,
          state: 'idle',
          terminalHandle: handle,
          processIncarnation:
            attestedProcessIncarnation ?? runtime.getTerminalProcessIncarnation(handle)
        })

        if (params.peek || params.all) {
          const addressRows = params.all
            ? db.getAllMessagesForHandle(address, 100, typeFilter)
            : db.getUnreadMessages(address, typeFilter)
          const handleRows = params.all
            ? db.getAllMessagesForHandle(handle, 100, typeFilter)
            : db.getUnreadMessages(handle, typeFilter)
          const mergedById = new Map<string, (typeof addressRows)[number]>()
          for (const row of [...addressRows, ...handleRows]) {
            mergedById.set(row.id, row)
          }
          const merged = [...mergedById.values()].sort((a, b) => a.sequence - b.sequence)
          const legacyPending = merged.filter(
            (row) => row.run_id === ORCHESTRATION_LEGACY_RUN_ID
          ).length
          const visible = params.all
            ? merged
            : merged.filter((row) => row.run_id !== ORCHESTRATION_LEGACY_RUN_ID)
          return {
            mailbox: address,
            agentId: callerAgentRow.id,
            messages: visible,
            count: visible.length,
            legacyPending,
            ...(params.format || params.inject
              ? { formatted: visible.map(formatMessageBanner).join('\n\n') }
              : {})
          }
        }

        const durable = readMailboxDelivery(db, {
          mailboxHandle: address,
          // Why fetched here (inside the callback, run AFTER the ack): see readMailboxDelivery's
          // own comment — a candidate query run before the ack would still see the prior
          // delivery's ids as unread and hand them back into the new one.
          fetchCandidates: () => {
            const addressUnread = db.getUnreadMessages(address, typeFilter)
            const handleUnread = db.getUnreadMessages(handle, typeFilter)
            const unreadById = new Map<string, (typeof addressUnread)[number]>()
            for (const row of [...addressUnread, ...handleUnread]) {
              unreadById.set(row.id, row)
            }
            return [...unreadById.values()].sort((a, b) => a.sequence - b.sequence)
          },
          ack: params.ack
        })
        return {
          mailbox: address,
          agentId: callerAgentRow.id,
          deliveryId: durable.deliveryId,
          messages: durable.messages,
          count: durable.messages.length,
          replayed: durable.replayed,
          pendingBehind: durable.pendingBehind,
          legacyPending: durable.legacyPending,
          acknowledged: durable.acknowledged,
          ...(durable.omitted ? { omitted: durable.omitted } : {}),
          ...(params.format || params.inject
            ? {
                formatted: appendOmittedMessagesLine(
                  durable.messages.map(formatMessageBanner).join('\n\n'),
                  durable.omitted
                )
              }
            : {})
        }
      }

      // Why: unread:false is honored for one release as a compat shim so in-flight callers don't break (design doc §5).
      const showAll = params.all === true || (params.unread === false && params.peek !== true)
      const consumeUnread = !showAll && params.peek !== true

      // Why "the peer check branch": a bare terminal handle is the address two hand-started
      // agents actually use before either registers (A4/BUG 6). It shares this mailbox with any
      // genuinely-legacy pre-migration row, so — mirroring the agent:<id> branch above — a
      // legacy row is reported as `legacyPending` and left untouched, never thrown at the caller.
      // MUTATION PROOF: reinstating the old `throw new OrchestrationError('legacy_read_only', …)`
      // here fails T2-equivalent coverage for the bare-handle mailbox (peer mail must never throw
      // even when genuine legacy debt shares the same address).
      const readAndReturn = () => {
        if (!consumeUnread) {
          // --peek / --all: inspect everything (legacy rows included), no mutation, no throw.
          const messages = showAll
            ? db.getAllMessagesForHandle(handle, undefined, typeFilter)
            : db.getUnreadMessages(handle, typeFilter)
          return params.format || params.inject
            ? {
                messages,
                formatted: messages.map(formatMessageBanner).join('\n\n'),
                count: messages.length
              }
            : { messages, count: messages.length }
        }

        if (params.ackMode === 'implicit') {
          // Why the candidate query is INSIDE the callback (run AFTER the ack): see
          // readMailboxDelivery's own comment — a query run before the ack would still see the
          // prior delivery's ids as unread and hand them back into the newly-minted one.
          let legacyPending = 0
          const durable = readMailboxDelivery(db, {
            mailboxHandle: handle,
            fetchCandidates: () => {
              const rows = db.getUnreadMessages(handle, typeFilter)
              legacyPending = rows.filter(
                (message) => message.run_id === ORCHESTRATION_LEGACY_RUN_ID
              ).length
              return rows.filter((message) => message.run_id !== ORCHESTRATION_LEGACY_RUN_ID)
            },
            ack: params.ack
          })
          const result = {
            messages: durable.messages,
            count: durable.messages.length,
            deliveryId: durable.deliveryId,
            replayed: durable.replayed,
            pendingBehind: durable.pendingBehind,
            legacyPending,
            acknowledged: durable.acknowledged,
            ...(durable.omitted ? { omitted: durable.omitted } : {})
          }
          return params.format || params.inject
            ? {
                ...result,
                formatted: appendOmittedMessagesLine(
                  durable.messages.map(formatMessageBanner).join('\n\n'),
                  durable.omitted
                )
              }
            : result
        }

        // Destructive default (owner decision 3, dual behaviour): unchanged behavior for
        // current rows — mark-read on read, zero regression for in-flight callers.
        const messages = db.getUnreadMessages(handle, typeFilter)
        const legacyPending = messages.filter(
          (message) => message.run_id === ORCHESTRATION_LEGACY_RUN_ID
        ).length
        const current = messages.filter((message) => message.run_id !== ORCHESTRATION_LEGACY_RUN_ID)
        let visibleMessages = current
        if (current.length > 0) {
          // Why: unread check is an authoritative read path for worker_done/heartbeat, so reconcile lifecycle messages here too.
          visibleMessages = current.map((message) => {
            const reconciled = reconcileLifecycleMessage(db, message)
            return reconciled.action === 'rejected'
              ? (db.getMessageById(message.id) ?? message)
              : message
          })
          db.markAsRead(current.map((m) => m.id))
        }
        const result = { messages: visibleMessages, count: visibleMessages.length, legacyPending }
        return params.format || params.inject
          ? { ...result, formatted: visibleMessages.map(formatMessageBanner).join('\n\n') }
          : result
      }

      if (signal?.aborted) {
        return { messages: [], count: 0 }
      }
      const result = readAndReturn()
      if (result.count > 0 || !params.wait) {
        return result
      }

      // Why: signal aborts this waiter when the client socket closes, freeing the long-poll slot immediately rather than after timeoutMs (design doc §3.1).
      await runtime.waitForMessage(handle, {
        typeFilter: typeFilter as string[] | undefined,
        timeoutMs: params.timeoutMs ?? undefined,
        signal
      })
      if (signal?.aborted) {
        return { messages: [], count: 0 }
      }
      return readAndReturn()
    }
  }),

  defineMethod({
    name: 'orchestration.reply',
    params: ReplyParams,
    handler: async (
      params,
      {
        orchestrationCompatibilityEvidence,
        orchestrationCompatibilityCallerAuthority,
        runtime,
        legacyCoordinatorRunId,
        pairedDeviceId,
        clientKind
      }
    ) => {
      const db = runtime.getOrchestrationDb()
      if (isRemoteRunMailboxRequest({ remoteRunMailbox: params.remoteRunMailbox })) {
        assertRemoteRunMailboxCaller({ pairedDeviceId, clientKind })
      }
      const original = db.getMessageById(params.id)
      if (!original) {
        throw new Error(`Message not found: ${params.id}`)
      }
      if (
        legacyCoordinatorRunId &&
        (original.run_id !== legacyCoordinatorRunId ||
          (params.run !== undefined && params.run !== legacyCoordinatorRunId))
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          `Message ${params.id} does not belong to this adopted Run.`,
          { effectsApplied: false }
        )
      }
      if (
        original.run_id === ORCHESTRATION_LEGACY_RUN_ID ||
        original.delivery_contract === 'legacy_direct' ||
        original.delivery_contract === 'audit_only'
      ) {
        throw new OrchestrationError(
          'legacy_read_only',
          'Legacy orchestration messages are inspect-only; no reply was applied.',
          { effectsApplied: false }
        )
      }

      const question = db.getQuestion(params.id)
      // Amendment F: a peer ask (question_threads.run_id === PEER_RUN_ID) has no Dispatch, no
      // consumer_generation to fence on — resolveRemoteRunMailboxScope below assumes both and
      // must never see this row. answerPeerQuestion binds the reply to the attested caller's
      // directory id, requiring it equal question_threads.to_agent_id (ruling 3, T4) — never
      // params.from, which a caller fully controls.
      if (question && question.run_id === PEER_RUN_ID) {
        const hostId = runtime.getOrchestrationCompatibilityHostId() ?? 'local'
        const attested = runtime.verifyOrchestrationCompatibilityCaller(
          orchestrationCompatibilityEvidence,
          { currentRuntimeLaunchSufficient: true }
        )
        // S10-15 D6: split by cause — unattested vs attested-but-unregistered.
        if (!attested) {
          throw new OrchestrationError(
            'no_pane_identity',
            'A peer reply requires an attested, registered caller identity.',
            { nextSteps: peerNoPaneIdentityNextSteps(pairedDeviceId, clientKind) }
          )
        }
        const callerAgent = db.getAgentByPaneKey(hostId, attested.paneKey)
        if (!callerAgent) {
          throw new OrchestrationError(
            'no_registered_identity',
            'A peer reply requires a registered caller identity.',
            { nextSteps: peerNoRegisteredIdentityNextSteps(pairedDeviceId, clientKind) }
          )
        }
        const answered = db.answerPeerQuestion({
          runId: PEER_RUN_ID,
          messageId: question.message_id,
          callerAgentId: callerAgent.id,
          body: params.body,
          senderPaneKey: attested?.paneKey,
          senderHostId: hostId,
          acknowledgeGate: params.acknowledgeGate
        })
        if (answered.outcome === 'refused') {
          throw gateVerdictRefusalError(answered.verdict, answered.refusalId)
        }
        if (answered.outcome === 'not_the_addressee') {
          throw new OrchestrationError(
            'not_the_addressee',
            `You are not the addressee of question ${question.message_id}.`
          )
        }
        if (answered.outcome === 'closed') {
          throw new OrchestrationError(
            'dispatch_inactive',
            `Question ${question.message_id} is closed.`
          )
        }
        if (answered.outcome === 'not_found') {
          throw new OrchestrationError('question_not_found', `Question ${params.id} was not found.`)
        }
        runtime.notifyMessageArrived(
          answered.message.to_handle,
          answered.message.type,
          answered.message.thread_id,
          extractPayloadKind(answered.message.payload_kind)
        )
        return {
          message: answered.message,
          question: answered.question,
          duplicate: answered.duplicate
        }
      }
      if (question) {
        const run = resolveRemoteRunMailboxScope(
          runtime,
          {
            runId: params.run ?? question.run_id,
            callerTerminalHandle: params.from,
            requireCurrentConsumer: true,
            legacyCoordinatorRunId,
            callerEvidence: orchestrationCompatibilityEvidence
          },
          { remoteRunMailbox: params.remoteRunMailbox, pairedDeviceId, clientKind }
        )
        const federated = db.getFederatedDispatch(question.dispatch_id)
        // Why: fence before the answer is recorded so a refused reply applies no effects;
        // an already-answered question still resolves to its recorded answer.
        if (federated && question.status === 'pending') {
          requireFederatedDispatchAcceptsWorkerMail(db, question.dispatch_id)
        }
        const answered = db.answerQuestion({
          messageId: question.message_id,
          runId: run.id,
          consumerGeneration: run.consumer_generation,
          body: params.body
        })
        if (federated) {
          // Why only a fresh answer: a replay resolves to the recorded reply, whose relay item
          // was queued the first time — and the fence above skips an answered question, so a
          // second enqueue would stack unpushable rows behind it once the Dispatch settles.
          if (!answered.duplicate) {
            db.enqueueFederationRelay({
              dispatchId: question.dispatch_id,
              direction: 'to_worker',
              kind: 'reply',
              payload: JSON.stringify({
                questionId: question.message_id,
                answerMessageId: answered.message.id,
                body: params.body
              })
            })
            runtime.ensureOrchestrationFederationRelay(run.id)
          }
        } else {
          runtime.notifyMessageArrived(`dispatch:${question.dispatch_id}`, 'status')
        }
        return {
          message: answered.message,
          question: answered.question,
          duplicate: answered.duplicate
        }
      }

      // Why: imported worker mail carries from_handle = dispatch:<id>, and a plain local insert
      // to that address is unreachable for a federated worker — it reads its peer's own mailbox.
      const workerDispatchId = original.from_handle.startsWith('dispatch:')
        ? original.from_handle.slice('dispatch:'.length)
        : undefined
      const federatedWorker = workerDispatchId
        ? db.getFederatedDispatch(workerDispatchId)
        : undefined
      if (workerDispatchId && federatedWorker) {
        if (
          federatedWorker.protocol_version < ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
        ) {
          throw new OrchestrationError(
            'capability_unsupported',
            `Federated Dispatch ${workerDispatchId} does not support coordinator control mail; start a fresh worker after updating its Orca server.`
          )
        }
        requireFederatedDispatchAcceptsWorkerMail(db, workerDispatchId)
      } else if (workerDispatchId) {
        requireActiveDispatchForWorkerMail(db, workerDispatchId)
      }

      db.markAsRead([original.id])

      if (workerDispatchId && federatedWorker) {
        const relay = db.enqueueFederationRelay({
          dispatchId: workerDispatchId,
          direction: 'to_worker',
          kind: 'control_message',
          payload: encodeFederatedControlMessage({
            // Why name the coordinator: the reply's default sender is the Run mailbox the
            // escalation was addressed to, which is not a handle the worker can answer.
            from:
              params.from ?? db.getRun(original.run_id)?.coordinator_handle ?? original.to_handle,
            subject: `Re: ${original.subject}`,
            body: params.body,
            type: 'status',
            priority: 'normal',
            threadId: original.thread_id ?? original.id,
            payload: null
          })
        })
        runtime.ensureOrchestrationFederationRelay(original.run_id)
        return {
          relay: {
            messageId: relay.message_id,
            sequence: relay.sequence,
            dispatchId: relay.dispatch_id,
            destination: 'worker',
            accepted: true
          },
          // Why keep `message`: every CLI shipped before the relay branch formats a reply as
          // `Replied ${r.message.id}`, so omitting it crashes an older client on a reply the
          // relay accepted — the reply lands and the coordinator never learns it did.
          message: { id: relay.message_id }
        }
      }

      // Amendment B: reply mirrors send's guards. `to_handle` is bound to `original.from_handle`
      // (never caller-supplied) but that address can itself be `agent:<id>` — the recipient of
      // THIS reply — so the same quarantine-then-derived checks send applies to an `agent:`
      // recipient apply here too, before the insert (ruling 3: "reply is a second to_handle
      // writer that can still carry an agent: address via a forged from").
      if (original.from_handle.startsWith('agent:')) {
        requireAddressableAgentRecipient(db, original.from_handle.slice('agent:'.length))
      }
      const replyFrom = params.from ?? original.to_handle
      const replyAttestedCaller =
        orchestrationCompatibilityCallerAuthority?.terminalHandle === replyFrom
          ? orchestrationCompatibilityCallerAuthority
          : undefined
      // Adversarial review major #4 fix — same shape as send's senderPaneKey above: an
      // attestation that disagrees with the claimed replyFrom must never fall back to trusting
      // replyFrom's own pane (that resolves and stamps a real, impersonated sender_agent_id).
      const replySenderPaneKey = replyAttestedCaller
        ? replyAttestedCaller.paneKey
        : orchestrationCompatibilityCallerAuthority
          ? undefined
          : (runtime.getTerminalPaneKey(replyFrom) ?? undefined)
      const replySenderHostId = runtime.getOrchestrationCompatibilityHostId() ?? 'local'

      // Amendment A: the plain reply insert routes through the single write choke too.
      const insertedReply = db.insertGatedMessage({
        from: replyFrom,
        to: original.from_handle,
        subject: `Re: ${original.subject}`,
        body: params.body,
        threadId: original.thread_id ?? original.id,
        runId: original.run_id,
        senderPaneKey: replySenderPaneKey,
        senderHostId: replySenderHostId,
        acknowledgeGate: params.acknowledgeGate,
        verb: 'reply'
      })
      if (insertedReply.outcome === 'refused') {
        throw gateVerdictRefusalError(insertedReply.verdict, insertedReply.refusalId)
      }
      const reply = insertedReply.message

      runtime.notifyMessageArrived(
        original.from_handle,
        reply.type,
        reply.thread_id,
        extractPayloadKind(reply.payload_kind)
      )
      return { message: reply }
    }
  }),

  defineMethod({
    name: 'orchestration.inbox',
    params: InboxParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      // Why: stale/unknown handles return empty rather than error — historical rows survive handle deletion (design doc §3.3).
      // Why threadId routes through resolveThreadReplay (ruling 1): `--thread-id` used to call
      // the recipient-unfiltered db.getThreadMessages directly, the same full-body leak
      // orchestration.thread had — hardened once, shared by both call sites.
      if (params.threadId) {
        return resolveThreadReplay(
          runtime,
          orchestrationCompatibilityEvidence,
          params.threadId,
          undefined
        )
      }
      const messages = params.terminal
        ? db.getAllMessagesForHandle(params.terminal, params.limit)
        : db.getInbox(params.limit)
      return { messages, count: messages.length }
    }
  }),

  defineMethod({
    name: 'orchestration.taskCreate',
    params: TaskCreateParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      let deps: string[] | undefined
      if (params.deps) {
        try {
          const parsed = JSON.parse(params.deps)
          if (!Array.isArray(parsed) || !parsed.every((d) => typeof d === 'string')) {
            throw new Error('not an array of strings')
          }
          deps = parsed
        } catch {
          throw new Error('Invalid --deps: must be a JSON array of task IDs')
        }
      }
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.callerTerminalHandle,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      const creatorAuthority = params.callerTerminalHandle
        ? runtime.getOrchestrationDispatchAuthority(params.callerTerminalHandle)
        : null
      const task = db.createTask({
        spec: params.spec,
        taskTitle: params.taskTitle,
        displayName: params.displayName,
        deps,
        parentId: params.parent,
        createdByTerminalHandle: params.callerTerminalHandle,
        ...(creatorAuthority?.paneKey && creatorAuthority.processIncarnation
          ? {
              createdByPaneKey: creatorAuthority.paneKey,
              createdByProcessIncarnation: creatorAuthority.processIncarnation,
              createdByRunGeneration: run.consumer_generation
            }
          : {}),
        runId: run.id
      })
      return { task }
    }
  }),

  defineMethod({
    name: 'orchestration.taskList',
    params: TaskListParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      const explicitRun = params.run ? db.getRun(params.run) : undefined
      const run =
        explicitRun?.legacy === 1
          ? explicitRun
          : resolveRunScope(runtime, {
              runId: params.run,
              callerTerminalHandle: params.callerTerminalHandle,
              requireCurrentConsumer: params.run === undefined,
              legacyCoordinatorRunId,
              callerEvidence: orchestrationCompatibilityEvidence
            })
      // Why: listTasksWithDispatch adds assignee_handle + dispatch_id (NULL for non-dispatched), so legacy-shape consumers are unaffected.
      const joined = db.listTasksWithDispatch({
        status: params.status as TaskStatus,
        ready: params.ready,
        runId: run.id
      })
      const tasks = joined.map((row) => {
        const { assignee_handle, dispatch_id, ...base } = row
        if (base.status === 'dispatched') {
          return { ...base, assignee_handle, dispatch_id }
        }
        return base
      })
      return {
        runId: run.id,
        legacyReadOnly: run.legacy === 1,
        tasks: params.brief ? abbreviateOrchestrationTasks(tasks) : tasks,
        count: tasks.length
      }
    }
  }),

  defineMethod({
    name: 'orchestration.taskUpdate',
    params: TaskUpdateParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.callerTerminalHandle,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      const existing = db.getTask(params.id)
      if (!existing || existing.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.id} was not found in Run ${run.id}.`
        )
      }
      const task = db.updateTaskStatus(params.id, params.status, params.result)
      if (!task) {
        throw new Error(`Task not found: ${params.id}`)
      }
      return { task }
    }
  }),

  defineMethod({
    name: 'orchestration.dispatch',
    params: DispatchParams,
    handler: async (
      params,
      {
        orchestrationCompatibilityEvidence,
        runtime,
        legacyCoordinatorRunId,
        revalidateLegacyCoordinator
      }
    ) => {
      const db = runtime.getOrchestrationDb()
      const task = db.getTask(params.task)
      if (!task) {
        throw new Error(`Task not found: ${params.task}`)
      }
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      if (task.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${task.id} was not found in Run ${run.id}.`
        )
      }

      // Why: dry-run previews the preamble without mutating state, so it skips the ready-status check and uses a placeholder dispatchId.
      if (params.dryRun) {
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          dispatchId: 'ctx_dryrun',
          taskSpec: task.spec,
          coordinatorHandle: params.from ?? 'coordinator',
          workerHandle: params.to ?? 'worker',
          devMode: params.devMode,
          ...(params.to
            ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(params.to) }
            : {})
        })
        return { dispatch: null, injected: false, dryRun: true, preamble }
      }

      if (!params.to) {
        throw new Error('Missing --to')
      }
      const to = params.to

      if (task.status !== 'ready') {
        throw new Error(`Task ${params.task} is ${task.status}; only ready tasks can be dispatched`)
      }

      // Why: injecting the preamble into a bare shell dumps it as shell commands (gibberish), so require a detected agent first.
      if (params.inject) {
        const hasAgent = await runtime.isTerminalRunningAgent(to)
        if (!hasAgent) {
          throw new Error(
            `Cannot dispatch --inject to terminal ${to}: no recognized agent detected. ` +
              'Start an agent CLI (e.g. claude, codex, gemini, droid, cursor) in the terminal first, ' +
              'or dispatch without --inject and send the prompt manually.'
          )
        }
      }

      const dispatchAuthority = runtime.getOrchestrationDispatchAuthority(to)
      const assigneePaneKey =
        dispatchAuthority?.paneKey ?? runtime.getTerminalPaneKey(to) ?? undefined
      const processIncarnation =
        dispatchAuthority?.paneKey && dispatchAuthority.processIncarnation
          ? dispatchAuthority.processIncarnation
          : undefined
      if (params.inject && (!assigneePaneKey || !processIncarnation)) {
        throw new OrchestrationError(
          'stable_pane_required',
          `Terminal ${to} has no stable pane/process incarnation for lifecycle authority.`
        )
      }

      revalidateLegacyCoordinator?.()
      const ctx = db.createDispatchContext(
        params.task,
        to,
        assigneePaneKey,
        dispatchAuthority?.launchTokenHash ?? undefined,
        processIncarnation
      )
      const dispatchCapability = params.inject
        ? db.mintDispatchCapability({
            dispatchId: ctx.id,
            paneKey: assigneePaneKey as string,
            processIncarnation: processIncarnation as string
          })
        : undefined

      // Why: built after ctx so dispatchId is the real ctx.id, letting heartbeats attribute liveness to a specific dispatch context, not just a task.
      const preamble = buildDispatchPreamble({
        taskId: task.id,
        dispatchId: ctx.id,
        taskSpec: task.spec,
        coordinatorHandle: params.from ?? 'coordinator',
        workerHandle: to,
        dispatchCapability,
        devMode: params.devMode,
        cliCommand: runtime.getTerminalOrchestrationCliCommand(to)
      })

      let injected = false
      if (params.inject) {
        try {
          await runtime.sendTerminalAgentPrompt(to, preamble)
          injected = true
        } catch (err) {
          db.failDispatch(ctx.id, err instanceof Error ? err.message : String(err))
          throw err
        }
      }

      // Why: returnPreamble is opt-in because the preamble is several hundred bytes most callers don't need in the response.
      if (params.returnPreamble) {
        return { dispatch: ctx, injected, preamble }
      }
      return { dispatch: ctx, injected }
    }
  }),

  defineMethod({
    name: 'orchestration.dispatchShow',
    params: DispatchShowParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (!params.task) {
        throw new Error('Missing --task')
      }
      const ctx = db.getDispatchContext(params.task)

      // Why: the preamble is derived from the current task spec, so it can be regenerated deterministically even after dispatch completes.
      if (params.preamble) {
        const task = db.getTask(params.task)
        if (!task) {
          throw new Error(`Task not found: ${params.task}`)
        }
        const workerHandle = ctx?.assignee_handle ?? 'worker'
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          // Why: use the real ctx.id when present so the preview matches what was injected; placeholder when no dispatch has occurred yet.
          dispatchId: ctx?.id ?? 'ctx_preview',
          taskSpec: task.spec,
          coordinatorHandle: params.from ?? 'coordinator',
          workerHandle,
          devMode: params.devMode,
          ...(ctx ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(workerHandle) } : {})
        })
        return { dispatch: ctx ?? null, preamble }
      }

      return { dispatch: ctx ?? null }
    }
  }),

  defineMethod({
    name: 'orchestration.ask',
    params: AskParams,
    handler: async (
      params,
      {
        runtime,
        signal,
        orchestrationCapability,
        recordMutationReceipt,
        orchestrationCompatibilityEvidence,
        pairedDeviceId,
        clientKind,
        orchestrationMutation
      }
    ) => {
      // Why: group addresses have no unambiguous first-answer authority.
      if (params.to && isGroupAddress(params.to)) {
        throw new Error(
          'ask does not support group addresses; use send for non-blocking fan-out questions'
        )
      }

      const db = runtime.getOrchestrationDb()
      const from = params.from ?? 'unknown'
      // Why: echoed on every return so a clamped caller reports the budget actually waited, not the one it asked for.
      const timeoutMs = clampOrchestrationAskTimeoutMs(params.timeoutMs)

      // Amendment F: a peer ask branch taken BEFORE the dispatch check below — `to` starting
      // with `agent:` (or resuming a question that was already minted as one) has nothing to do
      // with a supervised Dispatch, so it must never fall into the `dispatch_inactive` throw a
      // few lines down (s10-2-spec.md:120: "today a peer ask is impossible").
      const resumedPeerQuestion = params.resume ? db.getQuestion(params.resume) : undefined
      if (
        (params.to?.startsWith('agent:') ?? false) ||
        resumedPeerQuestion?.run_id === PEER_RUN_ID
      ) {
        // S10-8 R1/R2: `host` names a foreign agent's saved environment (CLI's `name@host`
        // resolution, agents-cross-host.ts's LOCAL_FIND_HOST sentinel is 'local') — relay
        // through THIS runtime rather than resolving `to` against this host's own directory.
        // `--resume` of a cross-host ask is out of scope here (R6 fence: a resumed wait is a
        // cross-host wait park) — an old/foreign resume id with no `host` falls through to
        // handlePeerAsk exactly as before and refuses question_not_found if it isn't local.
        if (params.host && params.host !== LOCAL_PEER_HOST) {
          return relayPeerAskToHost({
            params,
            runtime,
            db,
            timeoutMs,
            signal,
            recordMutationReceipt,
            orchestrationCompatibilityEvidence,
            orchestrationMutation
          })
        }
        return handlePeerAsk({
          params,
          runtime,
          db,
          timeoutMs,
          signal,
          recordMutationReceipt,
          orchestrationCompatibilityEvidence,
          resumedQuestion: resumedPeerQuestion,
          pairedDeviceId,
          clientKind
        })
      }

      const paneKey = runtime.getTerminalPaneKey(from) ?? undefined
      const remoteAttachment = paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
      if (remoteAttachment) {
        rejectFederatedExplicitTarget(params)
        return askRemoteRunHome({
          params: { ...params, timeoutMs },
          runtime,
          signal,
          orchestrationCapability,
          recordMutationReceipt,
          from,
          paneKey: paneKey as string,
          dispatchId: remoteAttachment.dispatch_id,
          taskId: remoteAttachment.task_id
        })
      }
      const activeDispatch = db.getActiveDispatchForIdentity(from, paneKey)
      if (!activeDispatch) {
        throw new OrchestrationError(
          'dispatch_inactive',
          'ask requires an active supervised Dispatch.'
        )
      }
      if (activeDispatch.capability_hash) {
        const authority = db.verifyDispatchCapability({
          dispatchId: activeDispatch.id,
          capability: orchestrationCapability,
          paneKey,
          processIncarnation: runtime.getTerminalProcessIncarnation(from) ?? undefined
        })
        if (!authority.valid) {
          throw new OrchestrationError('dispatch_capability_invalid', authority.reason)
        }
      }
      const options =
        params.options
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? []
      let question = params.resume ? db.getQuestion(params.resume) : undefined
      if (params.resume) {
        if (!question || question.dispatch_id !== activeDispatch.id) {
          throw new OrchestrationError(
            'question_not_found',
            `Question ${params.resume} does not belong to this active Dispatch.`
          )
        }
      } else {
        const run = db.getRun(activeDispatch.run_id)
        if (!run || run.legacy === 1) {
          throw new OrchestrationError(
            'run_not_found',
            `Run ${activeDispatch.run_id} was not found.`
          )
        }
        if (params.run && params.run !== run.id) {
          throw new OrchestrationError(
            'dispatch_run_mismatch',
            `Dispatch ${activeDispatch.id} belongs to Run ${run.id}, not ${params.run}.`
          )
        }
        if (params.to && params.to !== `run:${run.id}` && params.to !== run.coordinator_handle) {
          throw new OrchestrationError(
            'dispatch_run_mismatch',
            `ask from Dispatch ${activeDispatch.id} must target its owning Run ${run.id}.`
          )
        }
        const created = db.createQuestion({
          runId: run.id,
          dispatchId: activeDispatch.id,
          askerHandle: from,
          question: params.question as string,
          options
        })
        question = created.question
        runtime.notifyMessageArrived(
          `run:${run.id}`,
          created.message.type,
          created.message.thread_id,
          extractPayloadKind(created.message.payload_kind)
        )
      }

      const questionId = question.message_id
      recordMutationReceipt?.({
        accepted: true,
        answer: null,
        messageId: questionId,
        threadId: questionId,
        timedOut: false,
        cancelled: false,
        connectionLost: false,
        timeoutMs
      })
      const deadline = Date.now() + timeoutMs
      // Why the marker spans the whole verb and not each park: waitForMessage wakes on ANY mail
      // in the worker's dispatch mailbox, so an unrelated coordinator follow-up re-enters this
      // loop, and a marker re-stamped per park would hand back only the last sub-park (A1 §14).
      return whileDispatchBlocked(db, activeDispatch.id, async () => {
        while (true) {
          const current = db.getQuestion(questionId)
          if (!current || current.status === 'closed') {
            throw new OrchestrationError(
              'dispatch_inactive',
              `Question ${questionId} closed because its Dispatch is inactive.`
            )
          }
          if (current.status === 'answered') {
            return {
              answer: current.answer_body,
              messageId: questionId,
              answerMessageId: current.answer_message_id,
              threadId: questionId,
              timedOut: false,
              cancelled: false,
              connectionLost: false,
              timeoutMs
            }
          }
          if (signal?.aborted) {
            return {
              answer: null,
              messageId: questionId,
              threadId: questionId,
              timedOut: false,
              cancelled: true,
              connectionLost: true,
              timeoutMs
            }
          }
          const remainingMs = deadline - Date.now()
          if (remainingMs <= 0) {
            return {
              answer: null,
              messageId: questionId,
              threadId: questionId,
              timedOut: true,
              cancelled: false,
              connectionLost: false,
              timeoutMs
            }
          }
          await runtime.waitForMessage(`dispatch:${activeDispatch.id}`, {
            timeoutMs: remainingMs,
            signal
          })
        }
      })
    }
  }),

  ...ORCHESTRATION_GATE_METHODS,

  defineMethod({
    name: 'orchestration.reset',
    params: ResetParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (params.all) {
        runtime.stopOrchestrationFederationRelay()
        db.resetAll()
        return { reset: 'all' }
      }
      if (params.tasks) {
        runtime.stopOrchestrationFederationRelay()
        db.resetTasks()
        return { reset: 'tasks' }
      }
      if (params.messages) {
        db.resetMessages()
        return { reset: 'messages' }
      }
      throw new Error('Invalid reset scope')
    }
  })
]

// S10-8: agents-cross-host.ts's sentinel for "this host, not a saved environment" — duplicated
// here (not imported) because CLI code never reaches this main-process module; matches
// `runtime.getOrchestrationCompatibilityHostId() ?? 'local'`'s own literal a few lines below.
const LOCAL_PEER_HOST = 'local'

// S10-8 R5: a caller that reached this RPC over a paired runtime link (not a local pane) hitting
// no_pane_identity is very likely an old CLI that still opens a remote client directly for a
// `name@host` ask/reply (the R1 bug) instead of relaying through its OWN home runtime — a current
// CLI never sends this shape from a paired link, so the extra line is safe to always show here.
function peerNoPaneIdentityNextSteps(
  pairedDeviceId: string | undefined,
  clientKind: 'mobile' | 'runtime' | undefined
): readonly string[] {
  if (pairedDeviceId && clientKind === 'runtime') {
    return [
      ...NO_PANE_IDENTITY_NEXT_STEPS,
      'this looks like an old orca CLI addressing a remote agent directly — update Orca on the ' +
        'asking host: a current CLI relays a cross-host ask/reply through your own runtime automatically'
    ]
  }
  return NO_PANE_IDENTITY_NEXT_STEPS
}

// S10-15 D6: same paired-link condition as peerNoPaneIdentityNextSteps, for the
// attested-but-unregistered case.
function peerNoRegisteredIdentityNextSteps(
  pairedDeviceId: string | undefined,
  clientKind: 'mobile' | 'runtime' | undefined
): readonly string[] {
  if (pairedDeviceId && clientKind === 'runtime') {
    return [
      ...NO_REGISTERED_IDENTITY_NEXT_STEPS,
      'this pane is attested on its own host but has no registered agent row — run "orca agents register" there'
    ]
  }
  return NO_REGISTERED_IDENTITY_NEXT_STEPS
}

// S10-8 R1/R2: the home-side half of transport inversion. Called instead of handlePeerAsk when
// `params.host` names a foreign agent's saved environment. Resolves the caller's identity against
// THIS runtime exactly like handlePeerAsk does (never a second, remote pane-attestation check —
// there is no pane on the target host to attest), then relays the whole ask over the existing
// paired-link machinery (`callOrchestrationWorkerServer`, the same transport the dispatch relay
// and `agents list --all-hosts` probes already use) rather than resolving `to` against this
// host's own directory. The target host runs its OWN blocking wait (orchestration-federated-
// peer-ask.ts's `orchestration.federatedAsk`) and this call blocks right alongside it — one round
// trip carries both the question and, if answered in time, the answer, so no separate reply-relay
// or durable local question row is needed for this path (R4's "same link, same guards" reply
// routing falls out for free while this call is still parked; a reply that lands after this call
// has already timed out is the cross-host resume gap R6 fences off, not a bug here).
async function relayPeerAskToHost(args: {
  params: z.infer<typeof AskParams>
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  timeoutMs: number
  signal?: AbortSignal
  recordMutationReceipt?: (receipt: unknown) => void
  orchestrationCompatibilityEvidence?: OrchestrationCompatibilityEvidence
  // S10-8 review fix (blocker: dedup): this ask's own mutation identity, when the inbound call
  // carried one — used to derive a deterministic relay requestId (federation-sync.ts's
  // `relay_ack_${...}`/`relay_import_${...}` idiom) so a client-level retry of the SAME ask
  // lands on the SAME idempotency key on the receiving host instead of minting a second question.
  orchestrationMutation?: { requestId: string }
}): Promise<unknown> {
  const { params, runtime, db, timeoutMs } = args
  const caller = resolveCallerAgent(db, runtime, args.orchestrationCompatibilityEvidence)
  if (!params.to) {
    throw new OrchestrationError('invalid_argument', 'Missing --to for a peer ask.')
  }
  const toAgentId = params.to.slice('agent:'.length)
  const options =
    params.options
      ?.split(',')
      .map((option) => option.trim())
      .filter(Boolean) ?? []
  // Why re-fetch by id: resolveCallerAgent's ResolvedCallerAgent is deliberately the narrow,
  // pane-bound shape every other call site needs (id/pane_key/host_id) — it carries no
  // display_name. The registered directory row's display_name is what the target host renders
  // and what a reply addresses back (`name@origin-host`), never the raw terminal_handle (which
  // is shaped for a pane, not a display name — e.g. it may carry `_`, which
  // validateDisplayNameCandidate on the receiving end refuses).
  const callerRow = db.getAgentById(caller.id)
  // S10-8 review fix (blocker: quarantine crosses the link): a quarantined caller must never
  // reach the peer at all — refusing here, before the relay call, is what keeps `--host` from
  // being a one-flag bypass of local containment (mirrors requireCallerNotQuarantined's read-
  // at-action-time discipline for pact steps).
  if (callerRow?.quarantined === 1) {
    db.writeAgentAudit({
      agentId: callerRow.id,
      actorPaneKey: caller.pane_key,
      actorHostId: caller.host_id,
      verb: 'federatedAsk',
      outcome: 'agent_quarantined',
      reasonCode: null
    })
    throw new OrchestrationError(
      'agent_quarantined',
      `${callerRow.display_name} is quarantined and cannot ask across hosts.`,
      { nextSteps: [`orca agents quarantine ${callerRow.display_name} --lift`] }
    )
  }
  const result = (await runtime.callOrchestrationWorkerServer(
    params.host as string,
    'orchestration.federatedAsk',
    {
      // D1: single-sourced from federated-sender-identity.ts. `resolveCallerAgent` above already
      // guarantees a row exists, so the fallback branch is dead code that preserves today's
      // literal for review, never actually exercised.
      fromAgent: buildFederatedSenderIdentity(db, caller.id) ?? {
        id: caller.id,
        displayName: callerRow?.display_name ?? caller.id,
        role: callerRow?.role ?? null,
        // S10-8 review fix (blocker: quarantine crosses the link, half 2): carries THIS host's
        // own quarantine assertion for the caller so the receiving host can refuse it
        // independently of the check just above (defense in depth — never the only guard).
        quarantined: callerRow?.quarantined === 1
      },
      toAgentId,
      question: params.question,
      options,
      timeoutMs
    },
    timeoutMs + 15_000,
    // S10-8 review fix (blocker: dedup): deterministic when the inbound call carried an
    // idempotency key of its own, so a client-level retry (same requestId) coalesces on the
    // receiving host instead of minting a second question. No inbound key to derive from means
    // no dedup guarantee either way (same as before this fix) — a fresh id per call, never a
    // content hash, which would wrongly coalesce two deliberately-identical questions.
    {
      orchestrationRequestId: args.orchestrationMutation
        ? `relay_ask_${args.orchestrationMutation.requestId}`
        : `relay_ask_${randomUUID()}`
    }
  )) as {
    answer: string | null
    messageId: string
    answerMessageId?: string | null
    threadId: string
    timedOut: boolean
    cancelled?: boolean
    connectionLost?: boolean
    timeoutMs: number
  }
  args.recordMutationReceipt?.(result)
  return result
}

// Amendment F: the peer-ask counterpart of askRemoteRunHome above — no Dispatch, no
// consumer_generation, no whileDispatchBlocked marker (there is no dispatch_contexts row to
// mark). Identity is ONLY runtime.verifyOrchestrationCompatibilityCaller (never params.from),
// mirroring send/reply/agents.* (s10-2-spec.md:107).
async function handlePeerAsk(args: {
  params: z.infer<typeof AskParams>
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  timeoutMs: number
  signal?: AbortSignal
  recordMutationReceipt?: (receipt: unknown) => void
  orchestrationCompatibilityEvidence?: OrchestrationCompatibilityEvidence
  resumedQuestion?: QuestionRow
  pairedDeviceId?: string
  clientKind?: 'mobile' | 'runtime'
}): Promise<unknown> {
  const { params, runtime, db, timeoutMs, signal, recordMutationReceipt } = args
  const hostId = runtime.getOrchestrationCompatibilityHostId() ?? 'local'
  const attested = runtime.verifyOrchestrationCompatibilityCaller(
    args.orchestrationCompatibilityEvidence,
    { currentRuntimeLaunchSufficient: true }
  )
  // S10-15 D6: split by cause — unattested vs attested-but-unregistered.
  if (!attested) {
    throw new OrchestrationError(
      'no_pane_identity',
      'orca agents ask requires an attested, registered caller identity.',
      { nextSteps: peerNoPaneIdentityNextSteps(args.pairedDeviceId, args.clientKind) }
    )
  }
  const callerAgent = db.getAgentByPaneKey(hostId, attested.paneKey)
  if (!callerAgent) {
    throw new OrchestrationError(
      'no_registered_identity',
      'orca agents ask requires a registered caller identity.',
      { nextSteps: peerNoRegisteredIdentityNextSteps(args.pairedDeviceId, args.clientKind) }
    )
  }

  let question = args.resumedQuestion
  if (question) {
    if (question.run_id !== PEER_RUN_ID) {
      throw new OrchestrationError(
        'question_not_found',
        `Question ${params.resume} does not belong to a peer ask.`
      )
    }
  } else {
    if (!params.to) {
      throw new OrchestrationError('invalid_argument', 'Missing --to for a peer ask.')
    }
    const toAgent = requireAddressableAgentRecipient(db, params.to.slice('agent:'.length))
    const options =
      params.options
        ?.split(',')
        .map((option) => option.trim())
        .filter(Boolean) ?? []
    const questionText = params.question as string
    const { thread } = db.createThread({
      subject: deriveThreadSubject({ body: questionText }),
      createdByAgentId: callerAgent.id,
      origin: 'question',
      participants: [
        {
          participantKey: callerAgent.id,
          agentId: callerAgent.id,
          handle: callerAgent.terminal_handle,
          role: 'owner'
        },
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
      askerHandle: `agent:${callerAgent.id}`,
      toAgentId: toAgent.id,
      toHandle: `agent:${toAgent.id}`,
      question: questionText,
      options,
      senderPaneKey: attested?.paneKey,
      senderHostId: hostId,
      acknowledgeGate: params.acknowledgeGate
    })
    if (created.outcome === 'refused') {
      throw gateVerdictRefusalError(created.verdict, created.refusalId)
    }
    question = created.question
    db.bumpThreadOnMessage(thread.id, created.message)
    runtime.notifyMessageArrived(
      created.message.to_handle,
      created.message.type,
      created.message.thread_id,
      extractPayloadKind(created.message.payload_kind)
    )
  }

  const questionId = question.message_id
  const threadId = question.thread_key ?? questionId
  recordMutationReceipt?.({
    accepted: true,
    answer: null,
    messageId: questionId,
    threadId,
    timedOut: false,
    cancelled: false,
    connectionLost: false,
    timeoutMs
  })
  const deadline = Date.now() + timeoutMs
  const waitAddress = `agent:${callerAgent.id}`
  while (true) {
    const current = db.getQuestion(questionId)
    if (!current || current.status === 'closed') {
      throw new OrchestrationError('dispatch_inactive', `Question ${questionId} closed.`)
    }
    if (current.status === 'answered') {
      return {
        answer: current.answer_body,
        messageId: questionId,
        answerMessageId: current.answer_message_id,
        threadId,
        timedOut: false,
        cancelled: false,
        connectionLost: false,
        timeoutMs
      }
    }
    if (signal?.aborted) {
      return {
        answer: null,
        messageId: questionId,
        threadId,
        timedOut: false,
        cancelled: true,
        connectionLost: true,
        timeoutMs
      }
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return {
        answer: null,
        messageId: questionId,
        threadId,
        timedOut: true,
        cancelled: false,
        connectionLost: false,
        timeoutMs
      }
    }
    await runtime.waitForMessage(waitAddress, { timeoutMs: remainingMs, signal })
  }
}

async function askRemoteRunHome(args: {
  params: z.infer<typeof AskParams>
  runtime: OrcaRuntimeService
  signal?: AbortSignal
  orchestrationCapability?: string
  recordMutationReceipt?: (receipt: unknown) => void
  from: string
  paneKey: string
  dispatchId: string
  taskId: string
}): Promise<unknown> {
  const db = args.runtime.getOrchestrationDb()
  const timeoutMs = clampOrchestrationAskTimeoutMs(args.params.timeoutMs)
  if (
    !db.verifyRemoteAttachmentAuthority({
      dispatchId: args.dispatchId,
      capability: args.orchestrationCapability,
      paneKey: args.paneKey,
      processIncarnation: args.runtime.getTerminalProcessIncarnation(args.from)
    })
  ) {
    throw new OrchestrationError(
      'dispatch_capability_invalid',
      'The remote Dispatch capability or exact worker process is invalid.'
    )
  }
  const options =
    args.params.options
      ?.split(',')
      .map((option) => option.trim())
      .filter(Boolean) ?? []
  let questionId = args.params.resume
  if (questionId) {
    const existing = db.getRemoteQuestion(questionId)
    if (!existing || existing.dispatch_id !== args.dispatchId) {
      throw new OrchestrationError(
        'question_not_found',
        `Question ${questionId} does not belong to this remote Dispatch.`
      )
    }
  } else {
    const relay = db.enqueueFederationRelay({
      dispatchId: args.dispatchId,
      direction: 'to_home',
      kind: 'question',
      payload: JSON.stringify({
        from: args.from,
        subject: 'Question',
        body: args.params.question as string,
        type: 'question',
        priority: 'normal',
        threadId: null,
        payload: JSON.stringify({
          taskId: args.taskId,
          dispatchId: args.dispatchId,
          question: args.params.question,
          options
        })
      }),
      remoteQuestion: true
    })
    questionId = relay.message_id
  }
  args.recordMutationReceipt?.({
    accepted: true,
    answer: null,
    messageId: questionId,
    threadId: questionId,
    timedOut: false,
    cancelled: false,
    connectionLost: false,
    timeoutMs
  })
  const deadline = Date.now() + timeoutMs
  // Why the same marker on the peer, and once around the whole verb: a park is a park, and a
  // wake from unrelated mail must not shorten it. The peer holds no dispatch_contexts row for the
  // home's id, so this writes nothing there — the asymmetry is pinned by test, not fixed here.
  return whileDispatchBlocked(db, args.dispatchId, async () => {
    while (true) {
      const question = db.getRemoteQuestion(questionId)
      if (!question || question.status === 'closed') {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Question ${questionId} closed because its remote Dispatch is inactive.`
        )
      }
      if (question.status === 'answered') {
        return {
          answer: question.answer_body,
          messageId: questionId,
          answerMessageId: question.answer_message_id,
          threadId: questionId,
          timedOut: false,
          cancelled: false,
          connectionLost: false,
          timeoutMs
        }
      }
      if (args.signal?.aborted) {
        return {
          answer: null,
          messageId: questionId,
          threadId: questionId,
          timedOut: false,
          cancelled: true,
          connectionLost: true,
          timeoutMs
        }
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        return {
          answer: null,
          messageId: questionId,
          threadId: questionId,
          timedOut: true,
          cancelled: false,
          connectionLost: false,
          timeoutMs
        }
      }
      await args.runtime.waitForMessage(`dispatch:${args.dispatchId}`, {
        timeoutMs: remainingMs,
        signal: args.signal
      })
    }
  })
}
