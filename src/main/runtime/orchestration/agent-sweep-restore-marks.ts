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

/** [S10-21a C7c, D-R110 (ε)] The bulk read the renderer's ONE-TIME hydration uses
 * (`orchestration:sweepRestoreMark:list`) — every marked pane key for this host, so the
 * renderer never has to round-trip the per-key getter once per sleeping record. */
export function listSweepRestoreMarks(db: Database.Database, hostId: string): string[] {
  return (
    db.prepare(`SELECT pane_key FROM agent_sweep_restore_marks WHERE host_id = ?`).all(hostId) as {
      pane_key: string
    }[]
  ).map((row) => row.pane_key)
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
