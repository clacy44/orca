// S10-1b: DB writes for derived directory rows (CONTAINMENT #6). Split out of
// agent-directory.ts (which is at its max-lines budget) to keep both files under
// the repo's ratchet. A derived row is rebuilt per live pane, never accumulated:
// refreshing an existing derived row updates its mutable fields but keeps the
// display_name it was minted with; a registered (non-derived) row is left alone.
import { randomBytes } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { deriveDisplayName } from './agent-derivation'
import type { AgentRow } from './types'

function generateAgentId(): string {
  return `agt_${randomBytes(6).toString('hex')}`
}

function paneSuffix(paneKey: string): string {
  const idx = paneKey.indexOf(':')
  return idx === -1 ? paneKey : paneKey.slice(idx + 1)
}

/** Exact pane-suffix lookup, any derived value — used to attribute a message's
 * sender to a directory row (send) and to find the caller's own row (check). */
export function getAgentByPaneKey(
  db: Database.Database,
  hostId: string,
  paneKey: string
): AgentRow | undefined {
  return db
    .prepare(
      `SELECT * FROM agents
       WHERE host_id = ? AND tombstoned_at IS NULL
         AND pane_key IS NOT NULL AND substr(pane_key, instr(pane_key, ':') + 1) = ?`
    )
    .get(hostId, paneSuffix(paneKey)) as AgentRow | undefined
}

export type UpsertDerivedAgentForPaneParams = {
  hostId: string
  paneKey: string
  terminalHandle: string | null
  processIncarnation: string | null
  worktreeId: string | null
  worktreePath: string | null
  branch: string | null
  title: string | null
  agentLabel: string | null
}

/** Refreshes (or mints) a derived row for one live pane. A pane already owned by a
 * registered row is left untouched — derivation never overwrites an agent's own
 * registration. Returns the row, or undefined when the pane belongs to a
 * registered row (nothing to refresh here). */
export function upsertDerivedAgentForPane(
  db: Database.Database,
  params: UpsertDerivedAgentForPaneParams
): AgentRow | undefined {
  const suffix = paneSuffix(params.paneKey)
  const existing = db
    .prepare(
      `SELECT * FROM agents
       WHERE host_id = ? AND tombstoned_at IS NULL
         AND pane_key IS NOT NULL AND substr(pane_key, instr(pane_key, ':') + 1) = ?`
    )
    .get(params.hostId, suffix) as AgentRow | undefined
  if (existing && existing.derived === 0) {
    return undefined // registered row owns this pane; derivation does not touch it
  }
  if (existing) {
    db.prepare(
      `UPDATE agents SET terminal_handle = ?, process_incarnation = ?, worktree_id = ?,
         worktree_path = ?, branch = ?, title = ?, agent_label = ?, pane_key = ?,
         last_seen_at = datetime('now')
       WHERE id = ?`
    ).run(
      params.terminalHandle,
      params.processIncarnation,
      params.worktreeId,
      params.worktreePath,
      params.branch,
      params.title,
      params.agentLabel,
      params.paneKey,
      existing.id
    )
    return db.prepare('SELECT * FROM agents WHERE id = ?').get(existing.id) as AgentRow
  }
  const id = generateAgentId()
  const displayName = deriveDisplayName({
    branch: params.branch,
    worktreePath: params.worktreePath,
    title: params.title
  })
  db.prepare(
    `INSERT INTO agents (
       id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
       worktree_id, worktree_path, branch, title, agent_label, state, derived,
       origin_kind, origin_pane_key, origin_handle, origin_host_id
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', 1, 'derived', ?, ?, ?)`
  ).run(
    id,
    displayName,
    params.hostId,
    params.paneKey,
    params.terminalHandle,
    params.processIncarnation,
    params.worktreeId,
    params.worktreePath,
    params.branch,
    params.title,
    params.agentLabel,
    params.paneKey,
    params.terminalHandle,
    params.hostId
  )
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow
}

const STALE_DERIVED_AFTER_MS = 24 * 60 * 60 * 1000

/** Deletes derived rows that have gone stale (gone + untouched for 24h) — directory
 * hygiene, not tombstoning: a derived row carries no registration to preserve. */
export function pruneStaleDerivedAgents(db: Database.Database, hostId: string): number {
  const cutoff = new Date(Date.now() - STALE_DERIVED_AFTER_MS).toISOString()
  const result = db
    .prepare(
      `DELETE FROM agents
       WHERE host_id = ? AND derived = 1 AND state = 'gone' AND last_seen_at < ?`
    )
    .run(hostId, cutoff) as { changes: number }
  return result.changes
}
