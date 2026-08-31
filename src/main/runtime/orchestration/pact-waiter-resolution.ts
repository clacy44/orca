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

// Why 'reply' is here too (A4): a released pact must wake a `--for reply` park, or the agent
// that asked its counterpart a question sleeps to the clamp against a pact that no longer
// exists (the s10-2-spec deadlock rule). A waiter that registered no `for` at all is a legacy
// notify-only park and is never resolved through this channel.
const PACT_RESOLVABLE_KINDS = new Set<MessageWaiterKind>(['pact', 'step', 'reply'])

// Why threadId === null means "any thread": the turn_arrived case wakes a turn holder parked
// on a different pact than the one that just freed its turn — resolvePactWaiters's caller passes
// null there, never a specific thread, so a legacy message waiter (for undefined) never
// matches either branch and keeps its own notify-only contract.
export function waiterMatchesPactResolution(
  waiter: PactResolvableWaiter,
  threadId: string | null
): boolean {
  if (!waiter.for || !PACT_RESOLVABLE_KINDS.has(waiter.for)) {
    return false
  }
  return threadId === null || waiter.threadId === threadId
}
