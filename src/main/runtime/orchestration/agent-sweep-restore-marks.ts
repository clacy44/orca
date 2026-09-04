// S10-21a C1 (D-R92 P2): durable double-resume-prevention marks. Split out of
// agent-launch-sessions.ts to stay under the repo's max-lines budget — unrelated domain (the
// sweep's own state, not launch-session provenance).
import type Database from '../../sqlite/sync-database'

/** Write side only, called from the sweep's own transaction (C7) before its lock releases.
 * Idempotent (INSERT OR IGNORE). */
export function setSweepRestoreMark(db: Database.Database, hostId: string, paneKey: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO agent_sweep_restore_marks (host_id, pane_key) VALUES (?, ?)`
  ).run(hostId, paneKey)
}

export function getSweepRestoreMark(
  db: Database.Database,
  hostId: string,
  paneKey: string
): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM agent_sweep_restore_marks WHERE host_id = ? AND pane_key = ?`)
      .get(hostId, paneKey) !== undefined
  )
}

/** Marks are keyed by pane only per §7 — cleared as a whole, no per-generation clearing. */
export function clearSweepRestoreMark(
  db: Database.Database,
  hostId: string,
  paneKey: string
): void {
  db.prepare(`DELETE FROM agent_sweep_restore_marks WHERE host_id = ? AND pane_key = ?`).run(
    hostId,
    paneKey
  )
}
