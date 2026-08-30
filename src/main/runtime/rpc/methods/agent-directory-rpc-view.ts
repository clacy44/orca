// S10-1b: small shared utilities for the agents.* RPC surface — host id resolution, a rate-limit
// error helper, and the response field allowlist (CONTAINMENT #2). Split out of
// orchestration-agents.ts to stay under the max-lines ratchet.
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { AgentRow } from '../../orchestration/types'

export function hostIdFor(runtime: OrcaRuntimeService): string {
  return runtime.getOrchestrationCompatibilityHostId() ?? 'local'
}

export function rateLimited(retryAfterMs: number): OrchestrationError {
  return new OrchestrationError('rate_limited', 'Too many requests; try again shortly.', {
    retryAfterMs
  })
}

// CONTAINMENT #2: a per-response field allowlist so a new schema column cannot silently widen
// this surface. `full` additionally exposes fields safe only for the caller's own row.
export function toPublicAgentView(row: AgentRow, full: boolean): Record<string, unknown> {
  const base = {
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    host: row.host_id,
    state: row.state,
    derived: row.derived === 1,
    quarantined: row.quarantined === 1,
    title: row.title,
    branch: row.branch,
    worktreePath: row.worktree_path
  }
  if (!full) {
    return base
  }
  return {
    ...base,
    paneKey: row.pane_key,
    terminalHandle: row.terminal_handle,
    originKind: row.origin_kind,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at
  }
}
