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

// S10-15 D6 (finding: no_pane_identity conflated two distinct causes): the pane IS attested —
// re-attesting or relaunching cannot help, only registration can. Register-first, and say so
// explicitly, so a caller does not waste a retry cycle on the wrong fix (the misdirection this
// code exists to kill: "relaunch this agent in a fresh pane" when the pane was never the
// problem).
export const NO_REGISTERED_IDENTITY_NEXT_STEPS: readonly string[] = Object.freeze([
  'orca agents register --name <slug> --role "<your role>"',
  'orca agents list — to check whether this pane already registered under another name',
  'this pane IS attested; relaunching it will not help — only registration will'
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
  // S10-15 D6: split by cause — unattested (no_pane_identity, re-attest/relaunch can help) vs
  // attested-but-unregistered (no_registered_identity, only `orca agents register` can help).
  if (!attested) {
    throw new OrchestrationError(
      'no_pane_identity',
      'This requires an attested, registered caller identity.',
      { nextSteps: NO_PANE_IDENTITY_NEXT_STEPS }
    )
  }
  const agent = db.getAgentByPaneKey(hostId, attested.paneKey)
  if (!agent) {
    throw new OrchestrationError(
      'no_registered_identity',
      'This requires a registered agent identity for this pane.',
      { nextSteps: NO_REGISTERED_IDENTITY_NEXT_STEPS }
    )
  }
  return {
    id: agent.id,
    terminal_handle: agent.terminal_handle,
    pane_key: attested.paneKey,
    host_id: hostId
  }
}
