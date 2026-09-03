import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { parseThreadSinceCursor } from '../../orchestration/thread-replay-since-filter'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { MessageRow } from '../../orchestration/types'

// Why (S10-9 R4): a thread replay is where a sender goes to check on mail they sent into it —
// annotate their OWN messages with the same honest delivery state `orchestration sent` reports,
// so a stuck-behind-a-pane-gate message never reads identical to one nobody has pushed yet.
// Never annotates other participants' messages — delivery state is sender-side information.
function annotateSenderDeliveryHonesty(
  runtime: Parameters<RpcMethod['handler']>[1]['runtime'],
  messages: MessageRow[],
  callerHandle: string | undefined
): unknown[] {
  if (!callerHandle) {
    return messages
  }
  return messages.map((message) =>
    message.from_handle === callerHandle
      ? { ...message, delivery: runtime.getMessageDeliverySnapshot(message).delivery }
      : message
  )
}

const ThreadParams = z.object({
  id: requiredString('Missing --id'),
  since: OptionalString
})

// S10-2b ruling 1: `orchestration.thread` took its recipient-unfiltered replay from a bare
// thread id with no caller verification, no membership, and no sensitive check — any thread id
// (printed into panes and, for question threads, equal to the message id) handed out full
// bodies to anyone who typed it. Hardened, not left alone: identity is ONLY
// runtime.verifyOrchestrationCompatibilityCaller (never a caller-supplied handle); a full
// participant gets the full (still purge/quarantine-filtered, message-visibility-filter.ts)
// replay; a non-participant on a non-sensitive thread DEGRADES to a recipient-filtered replay
// (ruling 8) rather than being refused outright — RISK #2's "keep most callers working"; a
// non-participant on `sensitive=1` is refused outright, no bodies, no subject. A thread id with
// no `threads` row at all (pre-thread-directory traffic: a raw `insertMessage` call, or a row
// that predates this migration and was never backfilled) is treated the same as a non-sensitive,
// no-known-participants thread — degrade for everyone, never full.
function resolveThreadReplay(
  runtime: Parameters<RpcMethod['handler']>[1]['runtime'],
  orchestrationCompatibilityEvidence: Parameters<
    RpcMethod['handler']
  >[1]['orchestrationCompatibilityEvidence'],
  threadId: string,
  since: string | undefined
): {
  messages: unknown[]
  count: number
  degraded: boolean
  omitted?: { purged: number; withheld: number }
} {
  const db = runtime.getOrchestrationDb()
  const hostId = runtime.getOrchestrationCompatibilityHostId() ?? 'local'
  const attested = runtime.verifyOrchestrationCompatibilityCaller(
    orchestrationCompatibilityEvidence,
    { currentRuntimeLaunchSufficient: true }
  )
  const callerHandle = attested?.terminalHandle
  const callerAgentId = attested ? db.getAgentByPaneKey(hostId, attested.paneKey)?.id : undefined
  const participantKey = callerAgentId ?? callerHandle

  const cursor = since !== undefined ? parseThreadSinceCursor(since) : undefined
  const thread = db.getThread(threadId)
  const isParticipant =
    participantKey !== undefined && db.isThreadParticipant(threadId, participantKey)

  if (thread?.sensitive === 1 && !isParticipant) {
    throw new OrchestrationError(
      'not_a_participant',
      `Thread ${threadId} is sensitive; only its participants may read it.`,
      { nextSteps: ['orca agents threads (list threads you participate in)'] }
    )
  }

  if (isParticipant) {
    const messages = db.getThreadMessages(threadId, cursor)
    const omitted = db.getThreadMessagesOmitted(threadId, cursor)
    // Read receipts (S10-2b deferral, ruling 8): a full participant read moves their cursor to
    // the thread's current tip — markThreadRead is MAX()-monotonic, so this is safe to call on
    // every read, including one that returned zero new messages. participantKey is exactly
    // thread_participants.participant_key (agent id when attested, else the bare handle).
    if (participantKey !== undefined && thread) {
      db.markThreadRead(threadId, participantKey, thread.last_message_sequence)
    }
    return {
      messages: annotateSenderDeliveryHonesty(runtime, messages, callerHandle),
      count: messages.length,
      degraded: false,
      ...(omitted.purged > 0 || omitted.withheld > 0 ? { omitted } : {})
    }
  }

  // Degrade path: recipient-filtered by whatever handle we could attest, never the full
  // cross-participant replay. A fully anonymous caller (no evidence at all) gets nothing —
  // there is no handle to filter by, and "no identity -> full dump" is exactly ruling 1's bug.
  if (!callerHandle) {
    return { messages: [], count: 0, degraded: true }
  }
  const afterSequence = cursor?.kind === 'sequence' ? cursor.value : undefined
  // F-1 (Ruling 32(b)): a foreign-origin (peer-relayed) row is always addressed as
  // `agent:<id>`, never as the caller's bare terminal handle — matching on the handle alone
  // silently excluded every one of them from a degraded (non-participant) read even when the
  // caller genuinely was that agent. Match both forms when the caller resolves to one.
  const degradeAddresses = callerAgentId ? [callerHandle, `agent:${callerAgentId}`] : [callerHandle]
  const messages = db.getThreadMessagesFor(threadId, degradeAddresses, afterSequence)
  const omitted = db.getThreadMessagesOmitted(
    threadId,
    afterSequence !== undefined ? { kind: 'sequence', value: afterSequence } : undefined,
    degradeAddresses
  )
  return {
    messages: annotateSenderDeliveryHonesty(runtime, messages, callerHandle),
    count: messages.length,
    degraded: true,
    ...(omitted.purged > 0 || omitted.withheld > 0 ? { omitted } : {})
  }
}

// Why its own file: threads were write-only — send --thread-id wrote the column, indexed at
// idx_thread, but nothing replayed it (BUG 4). Kept off the ratcheted orchestration.ts file.
export const ORCHESTRATION_THREAD_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.thread',
    params: ThreadParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence }) => {
      return resolveThreadReplay(
        runtime,
        orchestrationCompatibilityEvidence,
        params.id,
        params.since
      )
    }
  })
]

// Exported so orchestration.ts's `orchestration.inbox --thread-id` branch (BUG 4: threadId
// "wins over --terminal") shares this exact hardening rather than keeping its own unguarded
// `db.getThreadMessages(params.threadId)` call — one implementation of the participant/degrade
// logic, not two copies that could drift.
export { resolveThreadReplay }
