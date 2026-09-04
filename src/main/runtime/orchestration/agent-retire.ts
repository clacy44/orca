// S10-7 F-B: `orca agents retire` DB writes. Split out of agent-directory.ts (at its max-lines
// budget) to stay under the repo's ratchet, same precedent as derived-agent-rows.ts.
import type Database from '../../sqlite/sync-database'
import { deleteLaunchRowsForAgent } from './agent-launch-sessions'
import { deleteCurrentSessionForPane } from './agent-launch-sessions-retention'
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
 * the write once the caller has decided it may proceed.
 *
 * [S10-21a C1, §2.11 the N4 fix, verbatim] `retireAgent`'s own transaction (the other half of
 * N4/Amendment 9). v2's C1 called `retireAgent`'s UPDATE "its own UPDATE transaction," but
 * D-R87 found `retireAgent` (`orchestration/agent-retire.ts:26-40`) is a bare UPDATE with no
 * transaction at all. v3 wraps `retireAgent`'s UPDATE and the launch-table row DELETE for that
 * agent in an explicit `BEGIN IMMEDIATE … COMMIT`, so the two writes are atomic — a retire
 * never leaves a launch-table row orphaned against a retired agent, nor a retired agent with a
 * stray launch row that could seed a future contest.
 *
 * [S10-21a C1a, errata 5(p)-5 §F item 6/D-R93 line 571] "the only deleters of current_sessions
 * are supersedePaneKey, retire, and deleteLaunchRow" names retire as a sanctioned deleter — not
 * silent on this, so no RETURN-block question. The retired agent's `current_sessions` row (its
 * pane, captured before the tombstone UPDATE clears `agents.pane_key`) is deleted in the same
 * transaction. */
export function retireAgent(db: Database.Database, id: string): RetireAgentResult {
  const existing = getAgentByIdIncludingTombstoned(db, id)
  if (!existing) {
    throw new OrchestrationError('agent_unknown', `Agent ${id} was not found.`)
  }
  if (existing.tombstoned_at) {
    return { outcome: 'already_retired', agent: existing }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE agents SET tombstoned_at = datetime('now'), pane_key = NULL,
         role = NULL, title = NULL, worktree_path = NULL WHERE id = ?`
    ).run(id)
    deleteLaunchRowsForAgent(db, id)
    if (existing.pane_key) {
      deleteCurrentSessionForPane(db, existing.host_id, existing.pane_key)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  const retired = getAgentByIdIncludingTombstoned(db, id) as AgentRow
  return { outcome: 'retired', agent: retired }
}
