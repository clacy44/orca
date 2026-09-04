// S10-21a C1a: `current_sessions` upsert, split out of agent-launch-sessions.ts so both it and
// agent-launch-sessions-retention.ts (deleteLaunchRow) can import it without a cycle.
import type Database from '../../sqlite/sync-database'

/** [errata 5(l), FORCED DEVIATION from §7's literal `INSERT OR REPLACE` text] Verified
 * empirically against node:sqlite: `INSERT OR REPLACE` applies its conflict resolution to EVERY
 * UNIQUE index on the table, not just the one in conflict — so a colliding session_id under a
 * different pane_key silently deletes that pane's row instead of raising, defeating the fence
 * errata 5(l) introduces this table for. `INSERT ... ON CONFLICT(host_id, pane_key) DO UPDATE`
 * targets only the same-pane conflict, so same-pane rewrites still upsert cleanly while a
 * cross-pane UNIQUE(host_id, session_id) collision is left unhandled and correctly raises
 * SQLITE_CONSTRAINT_UNIQUE, caught by isCurrentSessionsSuccessorViolation. */
export function upsertCurrentSession(
  db: Database.Database,
  hostId: string,
  paneKey: string,
  sessionId: string
): void {
  db.prepare(
    `INSERT INTO current_sessions (host_id, pane_key, session_id) VALUES (?, ?, ?)
     ON CONFLICT(host_id, pane_key) DO UPDATE SET session_id = excluded.session_id`
  ).run(hostId, paneKey, sessionId)
}
