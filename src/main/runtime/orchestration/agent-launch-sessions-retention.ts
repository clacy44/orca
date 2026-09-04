// S10-21a C1a (errata 5(p)-5 items 5-6): launch-row retention — pruning and the compensating
// delete. Split out of agent-launch-sessions.ts to stay under the repo's max-lines budget.
import type Database from '../../sqlite/sync-database'
import { upsertCurrentSession } from './current-session-upsert'

export const PRUNE_PER_PANE = 3
export const PRUNE_GLOBAL = 512

/** [errata 5(p)-5 item 6] Host-scoped, its own BEGIN IMMEDIATE…COMMIT, run AFTER recordLaunch's
 * transaction commits — never inside it, and never touches current_sessions. §7: <=3 rows per
 * pane_key (newest by seq). ORDER BY seq only. */
export function prunePaneRows(db: Database.Database, hostId: string, paneKey: string): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `DELETE FROM agent_launch_sessions
         WHERE host_id = ? AND pane_key = ? AND seq NOT IN (
           SELECT seq FROM agent_launch_sessions
             WHERE host_id = ? AND pane_key = ?
             ORDER BY seq DESC LIMIT ?
         )`
    ).run(hostId, paneKey, hostId, paneKey, PRUNE_PER_PANE)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** [errata 5(p)-5 item 6, D-D4 V3 binding] <=512 rows per host (oldest by seq), but never deletes
 * a row that is its pane's newest by seq — every current_sessions row must stay backed by a
 * launch row. With 513+ rows spread across many panes this can leave the per-host count ABOVE
 * 512 (every remaining row is some pane's newest); that is the bound honestly stated, not a bug. */
export function pruneGlobalRows(db: Database.Database, hostId: string): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `DELETE FROM agent_launch_sessions
         WHERE host_id = ?
           AND seq NOT IN (
             SELECT seq FROM agent_launch_sessions WHERE host_id = ? ORDER BY seq DESC LIMIT ?
           )
           AND seq NOT IN (
             SELECT MAX(seq) FROM agent_launch_sessions GROUP BY host_id, pane_key
           )`
    ).run(hostId, hostId, PRUNE_GLOBAL)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** [errata 5(p)-5 item 5] The compensation primitive (§C.6): deletes one row and repoints
 * current_sessions for its pane to that pane's next-newest session_id, or deletes the
 * current_sessions row when none remains. One transaction. A no-op (COMMIT, no error) if `seq`
 * does not exist — a compensating delete may race a caller who already cleaned up. One of the
 * three sanctioned current_sessions deleters, alongside `supersedePaneKey` and retire. */
export function deleteLaunchRow(db: Database.Database, seq: number): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const target = db
      .prepare(`SELECT host_id, pane_key FROM agent_launch_sessions WHERE seq = ?`)
      .get(seq) as { host_id: string; pane_key: string } | undefined
    if (!target) {
      db.exec('COMMIT')
      return
    }
    db.prepare(`DELETE FROM agent_launch_sessions WHERE seq = ?`).run(seq)
    const next = db
      .prepare(
        `SELECT session_id FROM agent_launch_sessions
           WHERE host_id = ? AND pane_key = ?
           ORDER BY seq DESC LIMIT 1`
      )
      .get(target.host_id, target.pane_key) as { session_id: string } | undefined
    if (next) {
      upsertCurrentSession(db, target.host_id, target.pane_key, next.session_id)
    } else {
      db.prepare(`DELETE FROM current_sessions WHERE host_id = ? AND pane_key = ?`).run(
        target.host_id,
        target.pane_key
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** [S10-21a C1a] Used by retireAgent inside its own transaction — one of the three sanctioned
 * current_sessions deleters (§F item 6). Deletes only if the row still names this pane's current
 * session (a retired agent's pane may already have moved on via a fresh launch). */
export function deleteCurrentSessionForPane(
  db: Database.Database,
  hostId: string,
  paneKey: string
): void {
  db.prepare(`DELETE FROM current_sessions WHERE host_id = ? AND pane_key = ?`).run(hostId, paneKey)
}

/** [S10-21a C3-v2d, D-R104 F-4] HOST_RESUME's compensation half: a failed restore (provider.spawn
 * throws, or the surface diverges post-spawn) must not leave the predecessor pane's
 * current_sessions row deleted with nothing to show for it — `recordLaunch`'s `supersedePaneKey`
 * already deleted that row inside the same transaction that inserted the new one (item 3 above);
 * `deleteLaunchRow(seq)` undoes the insert, this undoes that delete. Reads the predecessor pane's
 * own newest surviving launch row (NOT the just-deleted one — `deleteLaunchRow` already ran) and
 * upserts current_sessions from it; a no-op when the predecessor pane has no launch row left (it
 * never had one, or C1a's retention already pruned it — nothing to restore to). Not imported from
 * agent-launch-sessions.ts's `newestLaunchForPane` to avoid the import cycle that module already
 * has with this one (it imports `prunePaneRows`/`pruneGlobalRows` from here). */
export function restoreCurrentSessionForPane(
  db: Database.Database,
  hostId: string,
  paneKey: string
): void {
  const newest = db
    .prepare(
      `SELECT session_id FROM agent_launch_sessions WHERE host_id = ? AND pane_key = ?
         ORDER BY seq DESC LIMIT 1`
    )
    .get(hostId, paneKey) as { session_id: string } | undefined
  if (!newest) {
    return
  }
  upsertCurrentSession(db, hostId, paneKey, newest.session_id)
}
