// S10-3 pact spec RPCS §: orchestration.threads.step and orchestration.threads.pactLedger.
// Split out of orchestration-pact.ts (propose/accept/decline/pause/resume/release) per the
// max-lines ratchet.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { gateVerdictRefusalError } from '../../orchestration/gate-refusal-error'
import { PEER_RUN_ID } from '../../orchestration/db'
import { pactWaiterHandle } from '../../orchestration/pact-shared'
import { NO_PANE_IDENTITY_NEXT_STEPS, resolveCallerAgent } from './orchestration-caller-identity'
import { wakeTurnArrived } from './orchestration-pact-wake'

const StepParams = z.object({
  threadId: requiredString('Missing --thread'),
  done: requiredString('Missing --done'),
  acknowledgeGate: OptionalBoolean
})

const PactLedgerParams = z.object({
  threadId: requiredString('Missing --thread')
})

export const ORCHESTRATION_PACT_STEP_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.threads.step',
    params: StepParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const caller = resolveCallerAgent(db, runtime, orchestrationCompatibilityEvidence)
      const result = db.appendPactStep({
        callerAgentId: caller.id,
        callerPaneKey: caller.pane_key,
        callerHostId: caller.host_id,
        threadId: params.threadId,
        done: params.done,
        acknowledgeGate: params.acknowledgeGate,
        senderPaneKey: caller.pane_key,
        runId: PEER_RUN_ID
      })
      if (result.outcome === 'refused') {
        throw gateVerdictRefusalError(result.verdict, result.refusalId)
      }
      // A1/PANE PUSH §: notifies a `--for step` park scoped to this exact thread (and, absent
      // one, falls through to the ordinary pane-push path) — the same call shape send()/reply()
      // already use after insertGatedMessage (orchestration.ts), since appendPactStep's own
      // insert never goes through those handlers.
      runtime.notifyMessageArrived(
        pactWaiterHandle(result.turn),
        'status',
        result.thread.id,
        'pact_step'
      )
      // K19: the new turn holder may be parked on a DIFFERENT thread entirely — the turn-
      // transfer wake reaches it there too.
      wakeTurnArrived(runtime, result.turn, result.thread.id)
      const nextSteps = [`orca agents wait --thread ${result.thread.id} --for step`]
      return {
        ordinal: result.ordinal,
        of: result.of,
        turn: result.turn,
        messageId: result.message.id,
        sequence: result.message.sequence,
        gateFlags: result.gateFlags,
        nextSteps
      }
    }
  }),

  // Ruling 3: skeleton to any thread participant; summaries to the two pact participants, and
  // to a local non-federated caller who has NO agents row at all (exempt from no_pane_identity
  // on this read path only).
  defineMethod({
    name: 'orchestration.threads.pactLedger',
    params: PactLedgerParams,
    handler: (
      params,
      { runtime, orchestrationCompatibilityEvidence, pairedDeviceId, clientKind }
    ) => {
      const db = runtime.getOrchestrationDb()
      const thread = db.getThread(params.threadId)
      if (!thread) {
        throw new OrchestrationError('not_found', `Thread ${params.threadId} was not found.`)
      }
      const hostId = runtime.getOrchestrationCompatibilityHostId() ?? 'local'
      const attested = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence,
        { currentRuntimeLaunchSufficient: true }
      )
      const agent = attested ? db.getAgentByPaneKey(hostId, attested.paneKey) : undefined
      const isLocalNonFederatedOperator = pairedDeviceId === undefined && clientKind !== 'mobile'

      if (!agent) {
        if (!attested || !isLocalNonFederatedOperator) {
          throw new OrchestrationError(
            'no_pane_identity',
            'This requires an attested, registered caller identity.',
            { nextSteps: NO_PANE_IDENTITY_NEXT_STEPS }
          )
        }
        // The local-operator carve-out: no agents row, so no participant check to make —
        // ruling 3 grants the read directly.
        const ledger = db.getPactLedger({ threadId: params.threadId, revealSummaries: true })
        return { thread, ...ledger, nextSteps: [] }
      }

      if (!db.isThreadParticipant(params.threadId, agent.id)) {
        throw new OrchestrationError(
          'not_a_participant',
          `You are not a participant of thread ${params.threadId}.`
        )
      }
      // Ruling 3's local-operator carve-out is for a caller with NO agents row at all — a
      // registered agent's summary visibility is decided by pact participation only.
      const isPactParticipant =
        thread.pact_proposer_agent_id === agent.id || thread.pact_with_agent_id === agent.id
      const ledger = db.getPactLedger({
        threadId: params.threadId,
        revealSummaries: isPactParticipant
      })
      return { thread, ...ledger, nextSteps: [] }
    }
  })
]
