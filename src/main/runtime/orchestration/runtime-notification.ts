import type { OrchestrationDb } from './db'
import { extractPayloadKind } from './message-waiter-thread-keying'
import { RUNTIME_NOTIFICATION_MESSAGE_TYPE } from './types'

// Why a sender that is not the worker: A1 section 12 puts runtime-generated notices on the same
// escalation channel workers raise on, so a coordinator must be able to tell at a glance that the
// runtime said this and not the agent. payload.origin says the same thing to a machine reader.
export const RUNTIME_NOTIFICATION_SENDER = 'runtime'

export type RuntimeNotificationSink = {
  notifyMessageArrived: (
    handle: string,
    messageType?: string,
    threadId?: string | null,
    payloadKind?: string | null
  ) => void
}

// Why insert and notify are one call: the insert alone is the "printed into a void" shape — the row
// lands in the Run mailbox and every parked `check --wait` keeps sleeping until its own timeout.
export function postRuntimeNotification(args: {
  db: OrchestrationDb
  runtime: RuntimeNotificationSink
  runId: string
  subject: string
  body: string
  payload: Record<string, unknown>
}): void {
  const fullPayload = { origin: RUNTIME_NOTIFICATION_SENDER, ...args.payload }
  // Why also written to the payload_kind COLUMN (amendment D): these three notification kinds
  // (input_not_consumed / liveness_breach / relay_unreachable) stay in JSON payload.kind by
  // design (that JSON namespace is reserved for them), but every waiter/reservation read now
  // keys off the column exclusively (message-waiter-thread-keying.ts) — without this, a parked
  // `wait --for <kind>`-shaped consumer of a runtime notification would never match.
  const rawKind = (fullPayload as Record<string, unknown>).kind
  const payloadKind = typeof rawKind === 'string' ? rawKind : null
  const message = args.db.insertMessage({
    runId: args.runId,
    from: RUNTIME_NOTIFICATION_SENDER,
    to: `run:${args.runId}`,
    subject: args.subject,
    body: args.body,
    type: RUNTIME_NOTIFICATION_MESSAGE_TYPE,
    priority: 'high',
    payload: JSON.stringify(fullPayload),
    payloadKind
  })
  try {
    args.runtime.notifyMessageArrived(
      message.to_handle,
      message.type,
      message.thread_id,
      extractPayloadKind(message.payload_kind)
    )
  } catch (error) {
    // Why swallowed here rather than by every caller: the row is already in the mailbox, so a failed
    // wake costs a parked waiter its latency, not the notice — and rethrowing would make a caller
    // roll back a report it did in fact deliver.
    console.warn('[orchestration] runtime notification wake failed', error)
  }
}
