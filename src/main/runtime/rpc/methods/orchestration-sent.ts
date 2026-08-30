import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

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
        throw new Error(`Message not found: ${params.id}`)
      }
      const { delivery, recipient } = runtime.getMessageDeliverySnapshot(message)
      return { delivery: { state: delivery, recipient } }
    }
  })
]
