// S10-7 F-B: `orca agents retire` DB writes. Split out of agent-directory.ts (at its max-lines
// budget) to stay under the repo's ratchet, same precedent as derived-agent-rows.ts.
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import type { AgentRow } from './types'

/** The one deliberate exception to CONTAINMENT #8's "every read filters tombstoned_at IS
 * NULL" (agent-directory.ts) — used only where a caller must tell "never existed" apart from
 * "retired" (retire's own idempotency, and the mail-refusal path's agent_retired message). */
export function getAgentByIdIncludingTombstoned(
  db: Database.Database,
  id: string
): AgentRow | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
}

export type RetireAgentResult =
  | { outcome: 'retired'; agent: AgentRow }
  | { outcome: 'already_retired'; agent: AgentRow }

/** Tombstones a row and frees its display_name for reclaim (idx_agents_name is scoped to
 * `WHERE tombstoned_at IS NULL`, so this is the entire reclaim mechanism — no separate step
 * needed). Idempotent: retiring an already-tombstoned row is a no-op success, never an error,
 * so a retried/duplicated call is safe. The live-and-attested refusal (unless --force) is an
 * RPC-layer decision (it needs a fresh runtime liveness read) — this function only performs
 * the write once the caller has decided it may proceed. */
export function retireAgent(db: Database.Database, id: string): RetireAgentResult {
  const existing = getAgentByIdIncludingTombstoned(db, id)
  if (!existing) {
    throw new OrchestrationError('agent_unknown', `Agent ${id} was not found.`)
  }
  if (existing.tombstoned_at) {
    return { outcome: 'already_retired', agent: existing }
  }
  db.prepare(
    `UPDATE agents SET tombstoned_at = datetime('now'), pane_key = NULL,
       role = NULL, title = NULL, worktree_path = NULL WHERE id = ?`
  ).run(id)
  const retired = getAgentByIdIncludingTombstoned(db, id) as AgentRow
  return { outcome: 'retired', agent: retired }
}
