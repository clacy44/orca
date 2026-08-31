// S10-2b thread directory surface: orchestration.threads.create/.get/.list/.leave and
// orchestration.wait. Identity is ONLY runtime.verifyOrchestrationCompatibilityCaller — no
// params.from, no --terminal, no paneKey param (s10-2-spec.md RPCS §, binding). Kept off the
// ratcheted orchestration.ts file, same precedent as orchestration-thread.ts/
// orchestration-containment.ts.
//
// Scope note (deviation from s10-2-spec.md, documented rather than silently dropped):
// `.invite`/`.join`/`.receipts`/`.pact` and group-address expansion into a thread are NOT
// implemented in this series — `.create`/`.get`/`.list`/`.leave` plus `orchestration.wait` cover
// the load-bearing "start a thread, read it back, list mine, leave it, block for a reply" loop;
// the remaining verbs are a follow-up slice.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { clampOrchestrationAskTimeoutMs } from '../../../../shared/orchestration-ask-timeout'
import { deriveThreadSubject } from '../../../../shared/thread-subject'
import { resolveThreadReplay } from './orchestration-thread'
import type { OrchestrationDb } from '../../orchestration/db'

const CreateParams = z.object({
  subject: OptionalString,
  with: requiredString('Missing --with'),
  sensitive: z.boolean().optional()
})

const GetParams = z.object({
  id: requiredString('Missing --id'),
  since: OptionalString
})

const ListParams = z.object({
  state: z.enum(['open', 'paused', 'closed', 'all']).optional(),
  limit: OptionalFiniteNumber
})

const LeaveParams = z.object({
  id: requiredString('Missing --id')
})

const WaitParams = z.object({
  threadId: requiredString('Missing --thread'),
  for: z.enum(['reply', 'message', 'pact']),
  timeoutMs: OptionalFiniteNumber,
  resumeToken: OptionalString
})

function resolveCallerAgent(
  db: OrchestrationDb,
  runtime: Parameters<RpcMethod['handler']>[1]['runtime'],
  orchestrationCompatibilityEvidence: Parameters<
    RpcMethod['handler']
  >[1]['orchestrationCompatibilityEvidence']
): { id: string; terminal_handle: string | null } {
  const hostId = runtime.getOrchestrationCompatibilityHostId() ?? 'local'
  const attested = runtime.verifyOrchestrationCompatibilityCaller(
    orchestrationCompatibilityEvidence,
    { currentRuntimeLaunchSufficient: true }
  )
  const agent = attested ? db.getAgentByPaneKey(hostId, attested.paneKey) : undefined
  if (!agent) {
    throw new OrchestrationError(
      'no_pane_identity',
      'This requires an attested, registered caller identity.',
      { nextSteps: ['orca agents register --name <slug> --role "<your role>"'] }
    )
  }
  return agent
}

// `--with` resolves a comma-separated list of `agent:<id>` addresses (name resolution via
// S10-1 agents.find is CLI-layer sugar, S10-2c's job — the RPC takes resolved addresses).
function resolveWithAgents(
  db: OrchestrationDb,
  withParam: string
): NonNullable<ReturnType<OrchestrationDb['getAgentById']>>[] {
  const ids = withParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length === 0) {
    throw new OrchestrationError('invalid_argument', '--with must name at least one agent:<id>.')
  }
  return ids.map((entry) => {
    const id = entry.startsWith('agent:') ? entry.slice('agent:'.length) : entry
    const agent = db.getAgentById(id)
    if (!agent) {
      throw new OrchestrationError('agent_unknown', `Agent ${id} was not found.`, {
        nextSteps: ['orca agents find "<plain English description>"', 'orca agents list']
      })
    }
    if (agent.quarantined === 1) {
      throw new OrchestrationError(
        'agent_quarantined',
        `Agent ${agent.display_name} is quarantined and cannot join a thread.`
      )
    }
    return agent
  })
}

export const ORCHESTRATION_THREADS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.threads.create',
    params: CreateParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const caller = resolveCallerAgent(db, runtime, orchestrationCompatibilityEvidence)
      const others = resolveWithAgents(db, params.with)
      const { thread, participants } = db.createThread({
        subject: deriveThreadSubject({ explicit: params.subject, body: '' }),
        createdByAgentId: caller.id,
        sensitive: params.sensitive,
        participants: [
          {
            participantKey: caller.id,
            agentId: caller.id,
            handle: caller.terminal_handle,
            role: 'owner'
          },
          ...others.map((agent) => ({
            participantKey: agent.id,
            agentId: agent.id,
            handle: agent.terminal_handle,
            role: 'member' as const
          }))
        ]
      })
      return { thread, participants, nextSteps: [`orca agents thread --id ${thread.id}`] }
    }
  }),

  defineMethod({
    name: 'orchestration.threads.get',
    params: GetParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const replay = resolveThreadReplay(
        runtime,
        orchestrationCompatibilityEvidence,
        params.id,
        params.since
      )
      const thread = db.getThread(params.id)
      const participants = db.listThreadParticipants(params.id)
      return { thread, participants, ...replay }
    }
  }),

  defineMethod({
    name: 'orchestration.threads.list',
    params: ListParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const caller = resolveCallerAgent(db, runtime, orchestrationCompatibilityEvidence)
      const threads = db.listThreadsForParticipant({
        participantKey: caller.id,
        state: params.state,
        limit: params.limit
      })
      // §6: subjects only, never bodies — a sensitive thread's subject only to its own
      // participants, which listThreadsForParticipant already scopes to (the caller IS a
      // participant of every row it returns).
      return {
        threads: threads.map((thread) => ({
          id: thread.id,
          subject: thread.subject,
          state: thread.state,
          sensitive: thread.sensitive === 1,
          lastMessageAt: thread.last_message_at,
          messageCount: thread.message_count,
          pact:
            thread.pact_state !== null
              ? { state: thread.pact_state, turnAgentId: thread.pact_turn_agent_id }
              : null
        })),
        nextSteps: []
      }
    }
  }),

  defineMethod({
    name: 'orchestration.threads.leave',
    params: LeaveParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const caller = resolveCallerAgent(db, runtime, orchestrationCompatibilityEvidence)
      const thread = db.getThread(params.id)
      if (!thread) {
        throw new OrchestrationError('not_found', `Thread ${params.id} was not found.`)
      }
      db.leaveThread(params.id, caller.id)
      return { left: true }
    }
  }),

  // Amendment F / WAIT §: parks on runtime.waitForMessage('agent:'+callerAgentId, ...), then
  // filters to the thread and sequence > cursor. `--for reply` never resolves on the caller's
  // own post (WAIT §'s pact rule, generalized here to every thread — the caller waiting for a
  // reply to their own message should never be woken by their own message).
  defineMethod({
    name: 'orchestration.wait',
    params: WaitParams,
    handler: async (params, { runtime, orchestrationCompatibilityEvidence, signal }) => {
      const db = runtime.getOrchestrationDb()
      const caller = resolveCallerAgent(db, runtime, orchestrationCompatibilityEvidence)
      const thread = db.getThread(params.threadId)
      if (!thread) {
        throw new OrchestrationError('not_found', `Thread ${params.threadId} was not found.`)
      }
      if (!db.isThreadParticipant(params.threadId, caller.id)) {
        throw new OrchestrationError(
          'not_a_participant',
          `You are not a participant of thread ${params.threadId}.`
        )
      }
      const timeoutMs = clampOrchestrationAskTimeoutMs(params.timeoutMs)
      const resumeSequence = parseWaitResumeToken(params.resumeToken, params.threadId)
      // Why last_read_sequence, not thread.last_message_sequence: a fresh (no resumeToken) wait
      // must still catch a message that landed before this call started — thread.last_message_
      // sequence already reflects that message the moment it was bumped, so using it as the
      // cursor would exclude the exact row the caller is waiting for. last_read_sequence is this
      // participant's own "what I've already seen" cursor (0 for one who has never read), so an
      // unseen pre-existing message is still picked up on the first poll below.
      const participantRow = db
        .listThreadParticipants(params.threadId)
        .find((p) => p.participant_key === caller.id)
      const cursor = resumeSequence ?? participantRow?.last_read_sequence ?? 0
      const start = Date.now()
      const deadline = start + timeoutMs
      const waitAddress = `agent:${caller.id}`

      const isRelevant = (
        senderAgentId: string | null | undefined,
        fromHandle: string
      ): boolean => {
        if (params.for !== 'reply') {
          return true
        }
        return senderAgentId !== caller.id && fromHandle !== waitAddress
      }

      while (true) {
        const replay = db.getThreadMessagesSince(params.threadId, cursor)
        const relevant = replay.messages.filter((m) => isRelevant(m.sender_agent_id, m.from_handle))
        if (relevant.length > 0) {
          const lastSequence = relevant.at(-1)?.sequence as number
          return {
            outcome: params.for === 'pact' ? 'message' : params.for,
            messages: relevant,
            resumeToken: `wait_${params.threadId}_${lastSequence}`,
            waitedMs: Date.now() - start,
            nextSteps: []
          }
        }
        if (signal?.aborted) {
          return {
            outcome: 'cancelled',
            messages: [],
            resumeToken: `wait_${params.threadId}_${cursor}`,
            waitedMs: Date.now() - start,
            nextSteps: []
          }
        }
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          return {
            outcome: 'timeout',
            messages: [],
            resumeToken: `wait_${params.threadId}_${cursor}`,
            waitedMs: timeoutMs,
            nextSteps: [
              `orca agents wait --thread ${params.threadId} --for ${params.for} --resume wait_${params.threadId}_${cursor}`
            ]
          }
        }
        await runtime.waitForMessage(waitAddress, { timeoutMs: remainingMs, signal })
      }
    }
  })
]

// Why '<threadId>' is validated, not just the trailing number: a resume token copy-pasted
// against the wrong thread must not silently resume from an unrelated cursor.
function parseWaitResumeToken(
  resumeToken: string | undefined,
  threadId: string
): number | undefined {
  if (!resumeToken) {
    return undefined
  }
  const prefix = `wait_${threadId}_`
  if (!resumeToken.startsWith(prefix)) {
    throw new OrchestrationError(
      'invalid_argument',
      `--resume token does not belong to thread ${threadId}.`
    )
  }
  const value = Number(resumeToken.slice(prefix.length))
  if (!Number.isFinite(value)) {
    throw new OrchestrationError('invalid_argument', `Malformed --resume token: ${resumeToken}.`)
  }
  return value
}
