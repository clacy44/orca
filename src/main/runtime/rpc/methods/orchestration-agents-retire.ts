// S10-7 fix F-B: `orca agents retire <name|id>` — the cleanup half of quarantine -> retire
// (deliberate two-step: quarantine withholds mail from a suspect row, retire is the operator
// deciding it is really gone and freeing its name). Tombstones the row so its display_name
// becomes reclaimable (idx_agents_name is scoped to `WHERE tombstoned_at IS NULL` — freeing the
// name IS tombstoning it, no separate step) and writes an audit row.
//
// Local-operator-only, same gate as relink (orchestration-agents-relink.ts, ARBITRATION #2/#8):
// a federated peer asserting "retire this row" over the wire is exactly the unauthenticated
// directory-mutation the S10-4 trust boundary refuses elsewhere.
//
// Idempotency is keyed on --id, not --name: once retired, the row's display_name is free for
// someone else to reclaim under a DIFFERENT id, so a stale --name retry could silently target
// the wrong (successor) row. --id is looked up with the tombstone-inclusive raw read
// (getAgentByIdIncludingTombstoned) specifically so a retried call on an already-tombstoned id
// returns the same 'already_retired' success instead of throwing not_found.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { hostIdFor, toPublicAgentView } from './agent-directory-rpc-view'
import { refreshLiveness } from './agent-directory-rpc-liveness'
import { resolveCallerAgent } from './orchestration-caller-identity'

const RetireParams = z.object({
  id: OptionalString,
  name: OptionalString,
  force: OptionalBoolean
})

export const ORCHESTRATION_AGENTS_RETIRE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.agents.retire',
    params: RetireParams,
    handler: (
      params,
      { runtime, orchestrationCompatibilityEvidence, pairedDeviceId, clientKind }
    ) => {
      if (!params.id && !params.name) {
        throw new OrchestrationError('invalid_argument', 'Pass --id or --name.')
      }
      const isFederatedCaller = pairedDeviceId != null || clientKind === 'mobile'
      if (isFederatedCaller) {
        throw new OrchestrationError(
          'forbidden',
          'Retire must be issued locally by the operator, never by a federated peer.'
        )
      }
      const db = runtime.getOrchestrationDb()
      const hostId = hostIdFor(runtime)
      // [C13, Addendum 5(k)(5), D-R92 P4] The attested, registered caller is verified BEFORE
      // any mutation — same footing as orchestration-agents-register.ts's own first-line check
      // (no_pane_identity / no_registered_identity), via the shared resolveCallerAgent helper
      // (orchestration-caller-identity.ts:42-77) rather than a copy-pasted check. This used to
      // run only after db.retireAgent(...) had already tombstoned the row, solely to name the
      // audit row's actorPaneKey; it now gates the retire itself.
      const caller = resolveCallerAgent(db, runtime, orchestrationCompatibilityEvidence)
      const target = params.id
        ? db.getAgentByIdIncludingTombstoned(params.id)
        : db.getAgentByName(hostId, params.name!)
      if (!target) {
        throw new OrchestrationError(
          'not_found',
          `Agent ${params.id ?? params.name} was not found.`,
          { nextSteps: ['orca agents list'] }
        )
      }

      if (target.tombstoned_at) {
        return { agent: toPublicAgentView(target, true), outcome: 'already_retired' as const }
      }

      if (!params.force) {
        const { row: freshened } = refreshLiveness(runtime, db, target)
        if (freshened.state === 'live') {
          throw new OrchestrationError(
            'agent_live',
            `Agent ${target.display_name} is currently live and attested; pass --force to retire it anyway.`,
            { nextSteps: [`orca agents retire --id ${target.id} --force`] }
          )
        }
      }

      const outcome = db.retireAgent(target.id)
      db.writeAgentAudit({
        agentId: target.id,
        actorPaneKey: caller.pane_key,
        actorHostId: hostId,
        verb: 'retire',
        outcome: 'ok',
        reasonCode: null
      })
      return { agent: toPublicAgentView(outcome.agent, true), outcome: 'retired' as const }
    }
  })
]
