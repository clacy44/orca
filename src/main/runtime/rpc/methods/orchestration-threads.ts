// S10-2b thread directory surface: orchestration.threads.create/.get/.list/.leave. Identity is
// ONLY runtime.verifyOrchestrationCompatibilityCaller — no params.from, no --terminal, no
// paneKey param (s10-2-spec.md RPCS §, binding). Kept off the ratcheted orchestration.ts file,
// same precedent as orchestration-thread.ts/orchestration-containment.ts.
// orchestration.wait and orchestration.threads.pact/.step/.pactLedger moved to
// orchestration-wait.ts / orchestration-pact.ts / orchestration-pact-step.ts (S10-3) — see
// those files' own scope notes; this file's line budget could not absorb either.
//
// Scope note (deviation from s10-2-spec.md, documented rather than silently dropped):
// `.invite`/`.join`/`.receipts` and group-address expansion into a thread are NOT implemented
// in this series — `.create`/`.get`/`.list`/`.leave` cover the load-bearing "start a thread,
// read it back, list mine, leave it" loop; the remaining verbs are a follow-up slice.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { deriveThreadSubject } from '../../../../shared/thread-subject'
import { resolveThreadReplay } from './orchestration-thread'
import type { OrchestrationDb } from '../../orchestration/db'
import { resolveCallerAgent } from './orchestration-caller-identity'
import { wakePactThreadBoth } from './orchestration-pact-wake'

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
      // K17 (F7): a pact participant leaving its own thread is neither gone nor quarantined —
      // auto-pause counterpart_left so the other side isn't parked with no explanation. Only
      // when the leaver was actually a party to this thread's pact (a third member leaving a
      // pact thread it never joined the pact of changes nothing).
      if (thread.pact_proposer_agent_id === caller.id || thread.pact_with_agent_id === caller.id) {
        const outcome = db.autoPausePactOnThread(params.id, 'counterpart_left')
        if (outcome) {
          wakePactThreadBoth(
            runtime,
            params.id,
            [outcome.proposerAgentId, outcome.withAgentId],
            'paused',
            [`orca agents pact --release --on ${params.id}`]
          )
        }
      }
      return { left: true }
    }
  })
]
