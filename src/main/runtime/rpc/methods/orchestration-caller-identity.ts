// Identity is ONLY runtime.verifyOrchestrationCompatibilityCaller — no params.from, no
// --terminal, no paneKey param (s10-2-spec.md RPCS §, binding; s10-3-pact-spec.md AUTHORITY §
// repeats it verbatim for every pact verb). Extracted from orchestration-threads.ts so the pact
// RPC files (orchestration-pact.ts, orchestration-wait.ts) share one implementation rather than
// drifting copies.
import type { RpcMethod } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrchestrationDb } from '../../orchestration/db'

// Why: shared across every no_pane_identity refusal (agents/threads/pact/containment) so the
// disposition — not a bare failure — always names the recovery path, not copy-pasted per site.
// S10-5: the CLI already retries once through an automatic reattest (see
// src/cli/runtime/orchestration-compatibility-reattest.ts) before this error ever surfaces, so
// the wording here is platform-agnostic guidance for what's left once that retry has also failed
// — never shell-specific sourcing instructions (killed per the chair's S10-5 wording ruling).
export const NO_PANE_IDENTITY_NEXT_STEPS: readonly string[] = Object.freeze([
  're-run the command — the CLI re-attests this pane automatically after a runtime restart',
  'if it persists, relaunch this agent in a fresh Orca pane (claude --resume keeps its context)',
  'orca agents register --name <slug> --role "<your role>"'
])

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
      { nextSteps: NO_PANE_IDENTITY_NEXT_STEPS }
    )
  }
  return {
    id: agent.id,
    terminal_handle: agent.terminal_handle,
    pane_key: attested.paneKey,
    host_id: hostId
  }
}
