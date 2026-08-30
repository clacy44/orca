// Why this module: orca-runtime.ts (ratcheted) delegates the pact-wake selection math here.
// S10-3 pact spec A4 — a non-message wake channel for accept/decline/release/pause/turn-transfer,
// which write ledger rows and thread columns only and have no message row to drive notifyMessageArrived.
import type { MessageWaiterKind } from './message-waiter-thread-keying'

export function pactWaiterHandleForAgent(agentId: string): string {
  return `agent:${agentId}`
}

type PactResolvableWaiter = {
  for?: MessageWaiterKind
  threadId?: string
}

// Why threadId === null means "any thread": the turn_arrived case wakes a turn holder parked
// on a different pact than the one that just freed its turn — resolvePactWaiters's caller passes
// null there, never a specific thread, so a legacy message/reply waiter (for undefined) never
// matches either branch and keeps its own notify-only contract.
export function waiterMatchesPactResolution(
  waiter: PactResolvableWaiter,
  threadId: string | null
): boolean {
  if (waiter.for !== 'pact' && waiter.for !== 'step') {
    return false
  }
  return threadId === null || waiter.threadId === threadId
}
