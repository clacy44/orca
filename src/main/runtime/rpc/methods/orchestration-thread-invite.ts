// S10-2 threads.invite/.join (s10-2-spec.md:112), deferred by S10-2b's own scope note in
// orchestration-threads.ts — landed here since S10-3's sensitive-thread refusal
// (pact-spec.md's `orca agents invite --thread <t> --agent <name>` nextStep, A3) had nothing
// legal to point at otherwise. `.join` needs no CLI spelling of its own (A3 only adds one for
// `.invite`) — a caller who was invited already knows the thread id from the invite itself.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { resolveCallerAgent } from './orchestration-caller-identity'

const InviteParams = z.object({
  threadId: requiredString('Missing --thread'),
  agentId: requiredString('Missing --agent')
})

const JoinParams = z.object({
  threadId: requiredString('Missing --thread')
})

export const ORCHESTRATION_THREAD_INVITE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.threads.invite',
    params: InviteParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const caller = resolveCallerAgent(db, runtime, orchestrationCompatibilityEvidence)
      const thread = db.getThread(params.threadId)
      if (!thread) {
        throw new OrchestrationError('not_found', `Thread ${params.threadId} was not found.`)
      }
      if (!db.isThreadParticipant(params.threadId, caller.id)) {
        throw new OrchestrationError(
          'not_a_participant',
          `You are not a participant of thread ${params.threadId}.`,
          { nextSteps: ['orca agents threads'] }
        )
      }
      const invitee = db.getAgentById(params.agentId)
      if (!invitee) {
        throw new OrchestrationError('agent_unknown', `Agent ${params.agentId} was not found.`, {
          nextSteps: ['orca agents find "<plain English description>"', 'orca agents list']
        })
      }
      if (invitee.quarantined === 1) {
        throw new OrchestrationError(
          'agent_quarantined',
          `Refused: a pact needs two accountable participants and ${invitee.display_name} is quarantined. ` +
            `Lift it (orca agents quarantine ${invitee.display_name} --lift).`,
          { nextSteps: [`orca agents quarantine ${invitee.display_name} --lift`] }
        )
      }
      const participant = db.upsertThreadParticipant({
        threadId: params.threadId,
        participantKey: invitee.id,
        agentId: invitee.id,
        handle: invitee.terminal_handle,
        role: 'member',
        invitedByAgentId: caller.id,
        inviteState: 'pending'
      })
      return {
        participant,
        nextSteps: [`orca agents thread --id ${params.threadId}`]
      }
    }
  }),

  defineMethod({
    name: 'orchestration.threads.join',
    params: JoinParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const caller = resolveCallerAgent(db, runtime, orchestrationCompatibilityEvidence)
      const thread = db.getThread(params.threadId)
      if (!thread) {
        throw new OrchestrationError('not_found', `Thread ${params.threadId} was not found.`)
      }
      const existing = db
        .listThreadParticipants(params.threadId)
        .find((p) => p.participant_key === caller.id)
      if (!existing || existing.invite_state !== 'pending') {
        throw new OrchestrationError(
          'no_pending_invite',
          `Refused: you have no pending invite to thread ${params.threadId}.`,
          { nextSteps: ['orca agents threads'] }
        )
      }
      const participant = db.upsertThreadParticipant({
        threadId: params.threadId,
        participantKey: caller.id,
        agentId: caller.id,
        handle: caller.terminal_handle,
        role: existing.role,
        invitedByAgentId: existing.invited_by_agent_id,
        inviteState: 'accepted'
      })
      return { participant, nextSteps: [`orca agents thread --id ${params.threadId}`] }
    }
  })
]
