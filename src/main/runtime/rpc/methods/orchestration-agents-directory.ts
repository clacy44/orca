// S10-1b: orchestration.agents.list / .get. Split out of orchestration-agents.ts to stay under
// the max-lines ratchet — see that file for the shared CONTAINMENT #1 identity note.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalFiniteNumber, OptionalString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { refreshDerivedAgentsFromLiveGraph, refreshLiveness } from './agent-directory-rpc-liveness'
import { hostIdFor, toPublicAgentView } from './agent-directory-rpc-view'

const MINUTE_MS = 60 * 1000

const ListParams = z.object({
  state: z.enum(['live', 'idle', 'gone']).optional(),
  host: OptionalString,
  includeDerived: OptionalBoolean,
  includeQuarantined: OptionalBoolean,
  limit: OptionalFiniteNumber
})

const GetParams = z.object({
  id: OptionalString,
  name: OptionalString
})

export const ORCHESTRATION_AGENTS_DIRECTORY_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.agents.list',
    params: ListParams,
    handler: async (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const hostId = params.host ?? hostIdFor(runtime)

      const authority = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence,
        { currentRuntimeLaunchSufficient: true }
      )
      const rate = db.checkAndBumpRate({
        subjectKey: authority?.paneKey ?? hostId,
        verb: 'list',
        windowMs: MINUTE_MS,
        limit: 60
      })
      if (!rate.allowed) {
        throw new OrchestrationError('rate_limited', 'Too many requests; try again shortly.', {
          retryAfterMs: rate.retryAfterMs
        })
      }

      await refreshDerivedAgentsFromLiveGraph(runtime, db, hostId)

      const listing = db.listAgents({
        hostId,
        state: params.state,
        includeDerived: params.includeDerived ?? true,
        includeQuarantined: params.includeQuarantined ?? false,
        limit: params.limit
      })
      const agents = listing.agents.map((row) => {
        const { row: refreshed } = refreshLiveness(runtime, db, row)
        return toPublicAgentView(refreshed, false)
      })

      return {
        agents,
        liveCount: listing.liveCount,
        derivedCount: listing.derivedCount,
        omitted: listing.omitted
      }
    }
  }),
  defineMethod({
    name: 'orchestration.agents.get',
    params: GetParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence }) => {
      if (!params.id && !params.name) {
        throw new OrchestrationError('invalid_argument', 'Pass --id or --name.')
      }
      const db = runtime.getOrchestrationDb()
      const hostId = hostIdFor(runtime)
      const row = params.id ? db.getAgentById(params.id) : db.getAgentByName(hostId, params.name!)
      if (!row) {
        throw new OrchestrationError(
          'not_found',
          `Agent ${params.id ?? params.name} was not found.`,
          { nextSteps: ['orca agents find "<plain English description>"', 'orca agents list'] }
        )
      }
      const authority = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence,
        { currentRuntimeLaunchSufficient: true }
      )
      const callerRow = authority ? db.getAgentByPaneKey(hostId, authority.paneKey) : undefined
      const { row: refreshed, pushable } = refreshLiveness(runtime, db, row)
      const full = callerRow?.id === refreshed.id
      return { agent: toPublicAgentView(refreshed, full), pushable }
    }
  })
]
