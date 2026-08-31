// S10-4 ruling 5: `orca agents relink --env <name>` — the named reconciliation verb for a peer
// reimaged/reinstalled inside the same pairing. Wraps OrchestrationDb#relinkFederatedEnvironment
// (already landed, S10-4 schema series). Split out to its own file per the orchestration-agents-
// *.ts precedent (orchestration-agents.ts is just the concatenation index).
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'

const RelinkParams = z.object({
  environmentId: requiredString('Missing environmentId')
})

export const ORCHESTRATION_AGENTS_RELINK_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.agents.relink',
    params: RelinkParams,
    handler: (params, { runtime, pairedDeviceId, clientKind }) => {
      // Why local-only: relink resets THIS host's own relay cursors for a saved environment on
      // the operator's say-so that the peer was reimaged — a remote caller asserting that over
      // the wire is exactly the unauthenticated-reset the S10-4 trust boundary refuses elsewhere
      // (ARBITRATION #2/#8).
      const isFederatedCaller = pairedDeviceId != null || clientKind === 'mobile'
      if (isFederatedCaller) {
        throw new OrchestrationError(
          'forbidden',
          'Relink must be issued locally by the operator, never by a federated peer.'
        )
      }
      const db = runtime.getOrchestrationDb()
      return db.relinkFederatedEnvironment(params.environmentId)
    }
  })
]
