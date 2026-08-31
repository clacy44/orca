// S10-1b: orchestration.agents.quarantine. Split out of orchestration-agents.ts to stay under
// the max-lines ratchet.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { hostIdFor, rateLimited, toPublicAgentView } from './agent-directory-rpc-view'
import { wakePactThreadBoth } from './orchestration-pact-wake'

const DAY_MS = 24 * 60 * 60 * 1000

const QuarantineParams = z.object({
  id: OptionalString,
  name: OptionalString,
  lift: OptionalBoolean,
  reasonCode: OptionalString
})

export const ORCHESTRATION_AGENTS_QUARANTINE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.agents.quarantine',
    params: QuarantineParams,
    handler: (
      params,
      { runtime, orchestrationCompatibilityEvidence, pairedDeviceId, clientKind }
    ) => {
      if (!params.id && !params.name) {
        throw new OrchestrationError('invalid_argument', 'Pass --id or --name.')
      }
      const db = runtime.getOrchestrationDb()
      const hostId = hostIdFor(runtime)
      const target = params.id
        ? db.getAgentById(params.id)
        : db.getAgentByName(hostId, params.name!)
      if (!target) {
        throw new OrchestrationError(
          'not_found',
          `Agent ${params.id ?? params.name} was not found.`,
          { nextSteps: ['orca agents list'] }
        )
      }
      const authority = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence,
        { currentRuntimeLaunchSufficient: true }
      )
      const callerRow = authority ? db.getAgentByPaneKey(hostId, authority.paneKey) : undefined
      const isSelf = callerRow?.id === target.id
      const isFederatedCaller = pairedDeviceId != null || clientKind === 'mobile'
      if (isFederatedCaller && !isSelf) {
        throw new OrchestrationError(
          'forbidden',
          'Quarantine must be issued locally; a federated caller may only self-quarantine.'
        )
      }
      const rate = db.checkAndBumpRate({
        subjectKey: hostId,
        verb: 'quarantine',
        windowMs: DAY_MS,
        limit: 10
      })
      if (!rate.allowed) {
        throw rateLimited(rate.retryAfterMs)
      }
      const updated = db.setAgentQuarantine({
        id: target.id,
        quarantined: !params.lift,
        reasonCode: params.reasonCode ?? null
      })
      db.writeAgentAudit({
        agentId: target.id,
        actorPaneKey: authority?.paneKey ?? null,
        actorHostId: hostId,
        verb: params.lift ? 'quarantine_lift' : 'quarantine',
        outcome: 'ok',
        reasonCode: params.reasonCode ?? null
      })
      // Liveness § (K17): a quarantined side's step summaries are withheld, so its pacts can
      // only starve — auto-pause every engaged one and wake the counterpart now, with a
      // reason, instead of letting it run to the clamp. Never on lift: only quarantining pauses.
      if (!params.lift) {
        for (const outcome of db.autoPausePactsForAgent(target.id, 'counterpart_quarantined')) {
          wakePactThreadBoth(
            runtime,
            outcome.threadId,
            [outcome.proposerAgentId, outcome.withAgentId],
            'paused',
            [`orca agents pact --release --on ${outcome.threadId}`]
          )
        }
      }
      return { agent: toPublicAgentView(updated, isSelf) }
    }
  })
]
