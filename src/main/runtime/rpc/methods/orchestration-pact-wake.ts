// S10-3 pact spec A4 — the call-after-txn wake hook every pact state transition (and the
// liveness/leave/thread-close auto-pause paths) shares: resolvePactWaiters resolves a
// for:'pact'|'step'|'reply' park; it is always safe to call for an agent that isn't parked at
// all (a no-op). Split out so the RPC handlers (orchestration-pact.ts,
// orchestration-pact-step.ts, agent-directory-rpc-liveness.ts, orchestration-agents-quarantine
// .ts, orchestration-threads.ts's .leave) don't each re-derive this.
import type { OrcaRuntimeService } from '../../orca-runtime'

/** Wakes a waiter parked ON `threadId` specifically (accept/decline/release's own thread). */
export function wakePactThread(
  runtime: OrcaRuntimeService,
  agentId: string | null,
  threadId: string,
  outcome: string,
  nextSteps: string[]
): void {
  if (agentId) {
    runtime.resolvePactWaiters(agentId, threadId, outcome, nextSteps)
  }
}

/** Wakes both pact participants parked ON `threadId` (release/pause: either side may be
 * parked, and a no-op costs nothing for whichever isn't). */
export function wakePactThreadBoth(
  runtime: OrcaRuntimeService,
  threadId: string,
  participantAgentIds: readonly (string | null)[],
  outcome: string,
  nextSteps: string[]
): void {
  for (const agentId of participantAgentIds) {
    wakePactThread(runtime, agentId, threadId, outcome, nextSteps)
  }
}

/** Turn-transfer wake (A4): `threadId: null` matches a resolvable waiter of `agentId` parked on
 * ANY thread — accept/step/resume all call this for the agent the turn just moved to.
 * `arrivedOnThreadId` is passed as the separate detailThreadId (K19 blocker fix) so the resolved
 * wake's own `threadId` names the thread the turn actually arrived on, not null — the match
 * scope (any thread) and the reported acting thread are different things. */
export function wakeTurnArrived(
  runtime: OrcaRuntimeService,
  agentId: string | null,
  arrivedOnThreadId: string
): void {
  if (!agentId) {
    return
  }
  runtime.resolvePactWaiters(
    agentId,
    null,
    'turn_arrived',
    [`orca agents step --thread ${arrivedOnThreadId} --done "…"`],
    arrivedOnThreadId
  )
}
