import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'

const SentParams = z.object({
  id: requiredString('Missing --id')
})

// Why its own file: `orchestration.send`'s receipt is about the SENDER's own mail (BUG 3) —
// this is the delivery-state read the recipient's own mailbox already tracks, kept off the
// ratcheted orchestration.ts file as a delegating spread-in.
export const ORCHESTRATION_SENT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.sent',
    params: SentParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const message = db.getMessageById(params.id)
      if (!message) {
        // R4 (S10-11): a peer ask relayed cross-host (relayPeerAskToHost/orchestration.ts) mints
        // its message id on the TARGET host's own store — this host never wrote a row for it, by
        // design (no durable local question row for that path). A bare "not found" is
        // indistinguishable from a typo'd id; name the actual way out — `--environment <env>`
        // already works for ANY command via the global environment selector
        // (RuntimeClient/environments.ts) — never a raw, untyped Error.
        throw new OrchestrationError(
          'message_not_found',
          `Message ${params.id} was not found on this host.`,
          {
            nextSteps: [
              'if this was sent (or relayed) to a peer host, retry there: orca orchestration sent --id ' +
                `${params.id} --environment <name of that host>`,
              'orca environment show --environment <selector> (list the hosts you can retry against)'
            ]
          }
        )
      }
      const { delivery, recipient } = runtime.getMessageDeliverySnapshot(message)
      return { delivery: { state: delivery, recipient } }
    }
  })
]
