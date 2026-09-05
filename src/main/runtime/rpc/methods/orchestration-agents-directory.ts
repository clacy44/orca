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
    handler: async (params, { runtime, orchestrationCompatibilityEvidence, pairedDeviceId }) => {
      const db = runtime.getOrchestrationDb()
      const hostId = params.host ?? hostIdFor(runtime)

      const authority = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence,
        { currentRuntimeLaunchSufficient: true }
      )
      // S10-19 ops m13: an unattested LOCAL caller could otherwise choose its own rate bucket by
      // passing --host; never key on params.host. A paired caller keys on its own link identity
      // (never the host it claims to be), and an unattested local caller keys on this runtime's
      // own id, not the caller-supplied one.
      const rate = db.checkAndBumpRate({
        subjectKey:
          authority?.paneKey ??
          (pairedDeviceId ? `link:${pairedDeviceId}` : `host:${hostIdFor(runtime)}`),
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
      // [S10-21a C11] `sessionLaunchKnown` on the caller's own row only (§7/§8 row C11) — the
      // caller's own agent id, resolved once, never per-row from caller-supplied input.
      const callerRow = authority ? db.getAgentByPaneKey(hostId, authority.paneKey) : undefined
      const currentGeneration = runtime.getLaunchGenerationId()
      const agents = listing.agents.map((row) => {
        const { row: refreshed } = refreshLiveness(runtime, db, row)
        const sessionLaunchKnown =
          authority && callerRow?.id === refreshed.id
            ? db.newestLaunchForPane(hostId, authority.paneKey)?.launch_generation ===
              currentGeneration
            : undefined
        return toPublicAgentView(refreshed, false, sessionLaunchKnown)
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
    handler: (params, { runtime, orchestrationCompatibilityEvidence, pairedDeviceId }) => {
      if (!params.id && !params.name) {
        throw new OrchestrationError('invalid_argument', 'Pass --id or --name.')
      }
      const db = runtime.getOrchestrationDb()
      const hostId = hostIdFor(runtime)
      // W-5..W-7 review finding 8 (Ruling 24 addendum 4(ee)): agents.get was admitted on the
      // allowlist name alone and metered nowhere — a peer could probe arbitrary agent ids/names
      // at line rate. Metered the same way agents.list is (m13): never keyed on caller-supplied
      // input, an unattested local caller keys on this runtime's own id.
      const preAuthority = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence,
        { currentRuntimeLaunchSufficient: true }
      )
      const rate = db.checkAndBumpRate({
        subjectKey:
          preAuthority?.paneKey ??
          (pairedDeviceId ? `link:${pairedDeviceId}` : `host:${hostIdFor(runtime)}`),
        verb: 'get',
        windowMs: MINUTE_MS,
        limit: 60
      })
      if (!rate.allowed) {
        throw new OrchestrationError('rate_limited', 'Too many requests; try again shortly.', {
          retryAfterMs: rate.retryAfterMs
        })
      }
      const row = params.id ? db.getAgentById(params.id) : db.getAgentByName(hostId, params.name!)
      if (!row) {
        throw new OrchestrationError(
          'not_found',
          `Agent ${params.id ?? params.name} was not found.`,
          { nextSteps: ['orca agents find "<plain English description>"', 'orca agents list'] }
        )
      }
      const authority = preAuthority
      const callerRow = authority ? db.getAgentByPaneKey(hostId, authority.paneKey) : undefined
      const { row: refreshed, pushable } = refreshLiveness(runtime, db, row)
      const full = callerRow?.id === refreshed.id
      // [S10-21a C11] Same own-row-only rule as .list above.
      const sessionLaunchKnown = full
        ? db.newestLaunchForPane(hostId, authority!.paneKey)?.launch_generation ===
          runtime.getLaunchGenerationId()
        : undefined
      return { agent: toPublicAgentView(refreshed, full, sessionLaunchKnown), pushable }
    }
  })
]
