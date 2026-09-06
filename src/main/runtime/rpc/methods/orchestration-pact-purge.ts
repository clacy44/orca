// S10-21b B14 (design §4.6(b), §7 CLI): `orchestration.threads.purgePeerLedger` — the RPC B12b's
// CLI half (src/cli/handlers/agents-pact-federated.ts) already calls, against the
// PurgePeerLedgerResult = {purged, nextSteps} contract that file names.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, requiredString } from '../schemas'

const PurgePeerLedgerParams = z.object({
  linkId: requiredString('Missing --link <id>'),
  forceReleased: OptionalBoolean
})

export const ORCHESTRATION_PACT_PURGE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.threads.purgePeerLedger',
    params: PurgePeerLedgerParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      return db.purgePeerLedger({
        linkId: params.linkId,
        forceReleased: params.forceReleased ?? undefined
      })
    }
  })
]
