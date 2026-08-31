// S10-3 pact spec — orchestration.wait completed: `for:'step'` (ruling 5), the host-wide turn
// guard (K24, RISK-4/P4'), `--for pact`'s answer_first entry refusal (K23, closes the proposal
// ring), and the empty-filter/no-consumption rule for `--for pact` (rev 6). `message`/`reply`
// keep S10-2b's polling-loop shape — only gain the threadId-scoped park (A1).
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { clampOrchestrationAskTimeoutMs } from '../../../../shared/orchestration-ask-timeout'
import { ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS } from '../../../../shared/orchestration-message-wait-timeout'
import { resolveCallerAgent } from './orchestration-caller-identity'
import type { PactWaitDetail } from '../../orchestration/message-waiter-thread-keying'

const WaitParams = z.object({
  threadId: requiredString('Missing --thread'),
  for: z.enum(['reply', 'message', 'pact', 'step']),
  timeoutMs: OptionalFiniteNumber,
  resumeToken: OptionalString
})

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

type WaitHandlerContext = Parameters<RpcMethod['handler']>[1]

// K24 (P4', RISK-4): a caller holding the turn in ANY engaged, non-paused pact is refused every
// `wait` park — any `for`, any thread, the caller's own pact-thread included. Entry-only, never
// registers a waiter. A normal (exit-0) return, not a thrown refusal — the caller is not wrong
// to ask, it already has the answer.
function turnGuardResult(
  db: ReturnType<WaitHandlerContext['runtime']['getOrchestrationDb']>,
  callerAgentId: string
): {
  outcome: 'your_turn'
  messages: []
  resumeToken: null
  waitedMs: 0
  nextSteps: string[]
} | null {
  const turnsHeld = db.getTurnsHeldBy(callerAgentId)
  if (turnsHeld.length === 0) {
    return null
  }
  return {
    outcome: 'your_turn',
    messages: [],
    resumeToken: null,
    waitedMs: 0,
    nextSteps: turnsHeld.map((threadId) => `orca agents step --thread ${threadId} --done "…"`)
  }
}

// K23: closes the proposal ring (A→B, B→C, C→A) — every member owes an answer, so nobody can
// legally park `--for pact`. Global: not scoped to the thread the caller is trying to wait on.
function assertNoIncomingProposalOwed(
  db: ReturnType<WaitHandlerContext['runtime']['getOrchestrationDb']>,
  callerAgentId: string
): void {
  const incoming = db.getIncomingUnansweredProposal(callerAgentId)
  if (!incoming) {
    return
  }
  const proposer = incoming.pact_proposer_agent_id
    ? db.getAgentById(incoming.pact_proposer_agent_id)
    : undefined
  const proposerName = proposer?.display_name ?? incoming.pact_proposer_agent_id
  throw new OrchestrationError(
    'answer_first',
    `Refused: ${proposerName} is waiting on YOUR answer to its proposal on ${incoming.id} — ` +
      `accept or decline it first: orca agents pact --on ${incoming.id} --accept`,
    {
      nextSteps: [
        `orca agents pact --on ${incoming.id} --accept`,
        `orca agents pact --on ${incoming.id} --decline`
      ]
    }
  )
}

async function handlePactOrStepWait(
  params: {
    threadId: string
    for: 'pact' | 'step'
    resumeToken?: string
    timeoutMs?: number
  },
  ctx: WaitHandlerContext,
  callerAgentId: string,
  cursor: number
): Promise<unknown> {
  const { runtime, signal } = ctx
  const db = runtime.getOrchestrationDb()
  const start = Date.now()

  // A pending pact_step already on the thread (e.g. a resumed --for step) is returned without
  // parking at all — `--for pact` never takes this path (rev 6: it consumes no message, ever).
  if (params.for === 'step') {
    const pending = db
      .getThreadMessagesSince(params.threadId, cursor)
      .messages.filter((m) => m.payload_kind === 'pact_step')
    if (pending.length > 0) {
      const lastSequence = pending.at(-1)?.sequence as number
      return {
        outcome: 'step',
        messages: pending,
        resumeToken: `wait_${params.threadId}_${lastSequence}`,
        waitedMs: 0,
        nextSteps: []
      }
    }
  }

  const timeoutMs =
    params.for === 'step' && (params.timeoutMs === undefined || params.timeoutMs === 0)
      ? ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS // P3: a supplied 0 floors to 120s for --for step
      : clampOrchestrationAskTimeoutMs(params.timeoutMs)

  let detail: PactWaitDetail | undefined
  const result = await runtime.waitForMessage(`agent:${callerAgentId}`, {
    for: params.for,
    threadId: params.threadId,
    timeoutMs,
    signal,
    onDetail: (d) => {
      detail = d
    }
  })

  if (result === 'resolved' && detail) {
    // K19 blocker fix: detail.threadId now names the real acting thread even for a turn_arrived
    // wake (resolvePactWaiters's match scope for that case is threadId=null — "any thread of
    // this agent" — but its separate detailThreadId carries the real thread through to here).
    return {
      outcome: detail.outcome,
      threadId: detail.threadId,
      messages: [],
      resumeToken: `wait_${params.threadId}_${cursor}`,
      waitedMs: Date.now() - start,
      nextSteps: detail.nextSteps
    }
  }
  if (result === 'notified') {
    const pending = db
      .getThreadMessagesSince(params.threadId, cursor)
      .messages.filter((m) => m.payload_kind === 'pact_step')
    const lastSequence = pending.at(-1)?.sequence ?? cursor
    return {
      outcome: 'step',
      messages: pending,
      resumeToken: `wait_${params.threadId}_${lastSequence}`,
      waitedMs: Date.now() - start,
      nextSteps: []
    }
  }
  if (result === 'cancelled') {
    return {
      outcome: 'cancelled',
      messages: [],
      resumeToken: `wait_${params.threadId}_${cursor}`,
      waitedMs: Date.now() - start,
      nextSteps: []
    }
  }
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

export const ORCHESTRATION_WAIT_METHODS: RpcMethod[] = [
  // Amendment F / WAIT §: parks on runtime.waitForMessage('agent:'+callerAgentId, ...). `--for
  // reply` never resolves on the caller's own post (the caller waiting for a reply to their own
  // message should never be woken by their own message).
  defineMethod({
    name: 'orchestration.wait',
    params: WaitParams,
    handler: async (params, ctx) => {
      const { runtime, orchestrationCompatibilityEvidence, signal } = ctx
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

      // K24: entry-only, every `for`, every thread — checked before any other guard so a turn
      // holder never even learns whether it owes an answer elsewhere.
      const turnGuard = turnGuardResult(db, caller.id)
      if (turnGuard) {
        return turnGuard
      }
      if (params.for === 'pact') {
        assertNoIncomingProposalOwed(db, caller.id)
      }

      const resumeSequence = parseWaitResumeToken(params.resumeToken, params.threadId)
      const participantRow = db
        .listThreadParticipants(params.threadId)
        .find((p) => p.participant_key === caller.id)

      if (params.for === 'pact' || params.for === 'step') {
        // Why thread.last_message_sequence, not last_read_sequence, for a FRESH (no
        // resumeToken) step/pact park: a step is already learned synchronously (the `step` RPC's
        // own return value, or the pane push) — a fresh wait is for the NEXT one, never a replay
        // of the caller's own prior step (which nothing here ever marks read).
        const cursor = resumeSequence ?? thread.last_message_sequence
        return handlePactOrStepWait({ ...params, for: params.for }, ctx, caller.id, cursor)
      }

      const cursor = resumeSequence ?? participantRow?.last_read_sequence ?? 0

      const timeoutMs = clampOrchestrationAskTimeoutMs(params.timeoutMs)
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
            outcome: params.for,
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
        // threadId (A1): a park on one thread must never be woken/consumed by another thread's
        // traffic — the composite reservation key (message-waiter-thread-keying.ts) is what
        // makes that true even though this loop still re-polls the DB itself. `for` (A4): tags
        // the waiter so a released/declined pact's resolvePactWaiters call can also resolve a
        // `--for reply` park on that thread (K11/K20) — untagged, waiterMatchesPactResolution
        // never matches it.
        let detail: PactWaitDetail | undefined
        const result = await runtime.waitForMessage(waitAddress, {
          threadId: params.threadId,
          for: params.for,
          timeoutMs: remainingMs,
          signal,
          onDetail: (d) => {
            detail = d
          }
        })
        if (result === 'resolved' && detail) {
          return {
            outcome: detail.outcome,
            threadId: detail.threadId,
            messages: [],
            resumeToken: `wait_${params.threadId}_${cursor}`,
            waitedMs: Date.now() - start,
            nextSteps: detail.nextSteps
          }
        }
      }
    }
  })
]
