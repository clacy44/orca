// Identity is ONLY runtime.verifyOrchestrationCompatibilityCaller — no params.from, no
// --terminal, no paneKey param (s10-2-spec.md RPCS §, binding; s10-3-pact-spec.md AUTHORITY §
// repeats it verbatim for every pact verb). Extracted from orchestration-threads.ts so the pact
// RPC files (orchestration-pact.ts, orchestration-wait.ts) share one implementation rather than
// drifting copies.
import type { RpcMethod } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrchestrationDb } from '../../orchestration/db'

export type ResolvedCallerAgent = {
  id: string
  terminal_handle: string | null
  /** The attested pane key (AUTHORITY §: written to actor_pane_key on every pact ledger/audit
   * row) — never `undefined` once resolved, since resolution requires an attested pane. */
  pane_key: string
  host_id: string
}

export function resolveCallerAgent(
  db: OrchestrationDb,
  runtime: Parameters<RpcMethod['handler']>[1]['runtime'],
  orchestrationCompatibilityEvidence: Parameters<
    RpcMethod['handler']
  >[1]['orchestrationCompatibilityEvidence']
): ResolvedCallerAgent {
  const hostId = runtime.getOrchestrationCompatibilityHostId() ?? 'local'
  const attested = runtime.verifyOrchestrationCompatibilityCaller(
    orchestrationCompatibilityEvidence,
    { currentRuntimeLaunchSufficient: true }
  )
  const agent = attested ? db.getAgentByPaneKey(hostId, attested.paneKey) : undefined
  if (!agent || !attested) {
    throw new OrchestrationError(
      'no_pane_identity',
      'This requires an attested, registered caller identity.',
      { nextSteps: ['orca agents register --name <slug> --role "<your role>"'] }
    )
  }
  return {
    id: agent.id,
    terminal_handle: agent.terminal_handle,
    pane_key: attested.paneKey,
    host_id: hostId
  }
}
