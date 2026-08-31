import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { parseThreadSinceCursor } from '../../orchestration/thread-replay-since-filter'
import { OrchestrationError } from '../../orchestration/orchestration-error'

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
    return {
      messages,
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
  const messages = db.getThreadMessagesFor(threadId, callerHandle, afterSequence)
  const omitted = db.getThreadMessagesOmitted(
    threadId,
    afterSequence !== undefined ? { kind: 'sequence', value: afterSequence } : undefined,
    callerHandle
  )
  return {
    messages,
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
