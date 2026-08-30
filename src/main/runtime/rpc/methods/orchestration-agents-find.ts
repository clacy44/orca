// S10-1b: orchestration.agents.find (A3 resolver integration). Split out of
// orchestration-agents.ts to stay under the max-lines ratchet.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalFiniteNumber, requiredString } from '../schemas'
import {
  resolveAgentQuery,
  type AgentResolverCandidateInput,
  type AgentResolverScoredCandidate
} from '../../orchestration/agent-resolver'
import type { AgentRow } from '../../orchestration/types'
import { refreshDerivedAgentsFromLiveGraph, refreshLiveness } from './agent-directory-rpc-liveness'
import { hostIdFor, rateLimited } from './agent-directory-rpc-view'

const MINUTE_MS = 60 * 1000
const DIRECTORY_LIVE_CAP = 200

const FindParams = z.object({
  query: requiredString('Missing query'),
  limit: OptionalFiniteNumber,
  includeDerived: OptionalBoolean
})

export const ORCHESTRATION_AGENTS_FIND_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.agents.find',
    params: FindParams,
    handler: async (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const hostId = hostIdFor(runtime)

      const authority = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence,
        { currentRuntimeLaunchSufficient: true }
      )
      const agentRate = db.checkAndBumpRate({
        subjectKey: authority?.paneKey ?? hostId,
        verb: 'find',
        windowMs: MINUTE_MS,
        limit: 30
      })
      if (!agentRate.allowed) {
        throw rateLimited(agentRate.retryAfterMs)
      }
      const hostRate = db.checkAndBumpRate({
        subjectKey: hostId,
        verb: 'find',
        windowMs: MINUTE_MS,
        limit: 120
      })
      if (!hostRate.allowed) {
        throw rateLimited(hostRate.retryAfterMs)
      }

      await refreshDerivedAgentsFromLiveGraph(runtime, db, hostId)

      const listing = db.listAgents({
        hostId,
        includeDerived: params.includeDerived ?? true,
        includeQuarantined: false,
        limit: DIRECTORY_LIVE_CAP
      })
      const rowsById = new Map<string, AgentRow>()
      const candidates: AgentResolverCandidateInput[] = listing.agents.map((row) => {
        const { row: refreshed } = refreshLiveness(runtime, db, row)
        rowsById.set(refreshed.id, refreshed)
        return {
          id: refreshed.id,
          displayName: refreshed.display_name,
          role: refreshed.role,
          title: refreshed.title,
          worktreePath: refreshed.worktree_path,
          branch: refreshed.branch,
          state: refreshed.state,
          derived: refreshed.derived === 1
        }
      })

      const limit = Math.min(Math.max(params.limit ?? 5, 1), 20)
      const resolved = resolveAgentQuery(params.query, candidates)
      const trimmedCandidates = resolved.candidates.slice(0, limit)

      const withRole = trimmedCandidates.map((candidate: AgentResolverScoredCandidate) => ({
        ...candidate,
        role: rowsById.get(candidate.id)?.role ?? null,
        host: hostId
      }))

      const nextSteps =
        resolved.outcome === 'ambiguous'
          ? withRole.slice(0, 2).map((c) => `orca agents show --id ${c.id}`)
          : resolved.outcome === 'no_match'
            ? ['orca agents list']
            : []

      return {
        outcome: resolved.outcome,
        query: resolved.query,
        threshold: resolved.threshold,
        margin: resolved.margin,
        candidates: withRole,
        omitted: listing.omitted,
        nextSteps
      }
    }
  })
]
