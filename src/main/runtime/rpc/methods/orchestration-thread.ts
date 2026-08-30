import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { parseThreadSinceSequence } from '../../orchestration/thread-replay-since-filter'

const ThreadParams = z.object({
  id: requiredString('Missing --id'),
  since: OptionalString
})

// Why its own file: threads were write-only — send --thread-id wrote the column, indexed at
// idx_thread, but nothing replayed it (BUG 4). Kept off the ratcheted orchestration.ts file.
export const ORCHESTRATION_THREAD_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.thread',
    params: ThreadParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const messages = db.getThreadMessages(
        params.id,
        params.since !== undefined ? parseThreadSinceSequence(params.since) : undefined
      )
      return { messages, count: messages.length }
    }
  })
]
