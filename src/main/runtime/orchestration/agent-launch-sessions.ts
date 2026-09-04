// S10-21a C1 (§7, §2.2, §2.11; Ruling 34 Addendum 5): host-authored launch-session provenance.
// Store only — called by C3/C6/C7 and agent-retire.ts, none wired by this commit. Every write
// here is host-local (createTerminal's launch path, the sweep), never peer-writable.
import type Database from '../../sqlite/sync-database'

/** [D-R92 P5] 'self_report_rotation' is the one value not written by the launch path itself —
 * only by recordSelfReportRotation, gated by §1.6's four conjuncts (checked by C6, not here). */
export type LaunchEvidence = 'host_launch' | 'sweep_record' | 'self_report_rotation'

export type AgentLaunchSessionRow = {
  seq: number
  host_id: string
  pane_key: string
  agent_type: string
  session_id: string
  previous_session_id: string | null
  launch_generation: string
  agent_id: string | null
  execution_host_id: string
  evidence: LaunchEvidence
  recorded_at: string
}

export type RecordLaunchParams = {
  hostId: string
  paneKey: string
  agentType: string
  sessionId: string
  launchGeneration: string
  executionHostId: string
  evidence: Extract<LaunchEvidence, 'host_launch' | 'sweep_record'>
}

export type RecordSelfReportRotationParams = {
  hostId: string
  paneKey: string
  previousSessionId: string
  sessionId: string
  launchGeneration: string
  executionHostId: string
}

/** [errata 5(l)] `current_sessions.UNIQUE(host_id, session_id)` violation — the
 * successor-collision fence (T33). Typed refusal after ROLLBACK, never thrown, never swallowed. */
export type ForeignSessionIdRefusal = { ok: false; reason: 'foreign_session_id' }

/** Not in §7's schema note — added so a rotation can't upsert current_sessions with no backing
 * agent_launch_sessions row. C6 is expected to verify the anchor first; this is a defensive
 * fence, not a substitute. */
export type NoMatchingLaunchRowRefusal = { ok: false; reason: 'no_matching_launch_row' }

export type RecordLaunchResult = { ok: true; row: AgentLaunchSessionRow } | ForeignSessionIdRefusal

export type RecordSelfReportRotationResult =
  | { ok: true; row: AgentLaunchSessionRow }
  | ForeignSessionIdRefusal
  | NoMatchingLaunchRowRefusal

const PRUNE_PER_PANE = 3
const PRUNE_GLOBAL = 512

// node:sqlite (sync-database.ts) throws ERR_SQLITE_ERROR with a message naming the offending
// index's columns; matched by substring rather than errcode alone (2067 is shared by every
// UNIQUE violation on the connection).
function isCurrentSessionsSuccessorViolation(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false
  }
  const code = (err as { code?: unknown }).code
  return (
    code === 'ERR_SQLITE_ERROR' &&
    err.message.includes('current_sessions') &&
    err.message.includes('session_id')
  )
}

/** [errata 5(l), FORCED DEVIATION from §7's literal `INSERT OR REPLACE` text] Verified
 * empirically against node:sqlite: `INSERT OR REPLACE` applies its conflict resolution to EVERY
 * UNIQUE index on the table, not just the one in conflict — so a colliding session_id under a
 * different pane_key silently deletes that pane's row instead of raising, defeating the fence
 * errata 5(l) introduces this table for. `INSERT ... ON CONFLICT(host_id, pane_key) DO UPDATE`
 * targets only the same-pane conflict, so same-pane rewrites still upsert cleanly while a
 * cross-pane UNIQUE(host_id, session_id) collision is left unhandled and correctly raises
 * SQLITE_CONSTRAINT_UNIQUE, caught by isCurrentSessionsSuccessorViolation. */
function upsertCurrentSession(
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

// §7: <=3 rows per pane_key (newest by seq), <=512 globally (oldest by seq). ORDER BY seq only.
function prunePaneRows(db: Database.Database, hostId: string, paneKey: string): void {
  db.prepare(
    `DELETE FROM agent_launch_sessions
       WHERE host_id = ? AND pane_key = ? AND seq NOT IN (
         SELECT seq FROM agent_launch_sessions
           WHERE host_id = ? AND pane_key = ?
           ORDER BY seq DESC LIMIT ?
       )`
  ).run(hostId, paneKey, hostId, paneKey, PRUNE_PER_PANE)
}

function pruneGlobalRows(db: Database.Database): void {
  db.prepare(
    `DELETE FROM agent_launch_sessions
       WHERE seq NOT IN (
         SELECT seq FROM agent_launch_sessions ORDER BY seq DESC LIMIT ?
       )`
  ).run(PRUNE_GLOBAL)
}

/** [§2.2] INSERT into agent_launch_sessions + current_sessions upsert + §7 prune, one
 * BEGIN IMMEDIATE…COMMIT. Not best-effort: caller (C3) must refuse the launch loudly on
 * non-ok, never spawn with an unrecorded session id. */
export function recordLaunch(
  db: Database.Database,
  params: RecordLaunchParams
): RecordLaunchResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `INSERT INTO agent_launch_sessions
         (host_id, pane_key, agent_type, session_id, previous_session_id, launch_generation,
          agent_id, execution_host_id, evidence)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)`
    ).run(
      params.hostId,
      params.paneKey,
      params.agentType,
      params.sessionId,
      params.launchGeneration,
      params.executionHostId,
      params.evidence
    )
    upsertCurrentSession(db, params.hostId, params.paneKey, params.sessionId)
    prunePaneRows(db, params.hostId, params.paneKey)
    pruneGlobalRows(db)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    if (isCurrentSessionsSuccessorViolation(err)) {
      return { ok: false, reason: 'foreign_session_id' }
    }
    throw err
  }
  return { ok: true, row: launchBySessionId(db, params.sessionId) as AgentLaunchSessionRow }
}

/** [§1.6/§2.3] Updates the pane's existing row IN PLACE — never a new row, since
 * UNIQUE(host_id, pane_key, launch_generation) would reject a second row for the same
 * generation — then upserts current_sessions, same transaction. `seq` is left untouched: it was
 * already assigned at the row's original INSERT, after every other generation's row for this
 * pane, so it is already the newest by seq without reassignment (JUDGMENT CALL: reads the
 * design's "advances the monotonic ordering column" as "remains correctly newest," not "seq's
 * value changes" — see RETURN block). Caller (C6) is expected to have verified §1.6's other
 * three conjuncts; this enforces only the fourth (successor uniqueness). */
export function recordSelfReportRotation(
  db: Database.Database,
  params: RecordSelfReportRotationParams
): RecordSelfReportRotationResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const updated = db
      .prepare(
        `UPDATE agent_launch_sessions
           SET session_id = ?, previous_session_id = ?, evidence = 'self_report_rotation',
               recorded_at = datetime('now')
         WHERE host_id = ? AND pane_key = ? AND launch_generation = ?`
      )
      .run(
        params.sessionId,
        params.previousSessionId,
        params.hostId,
        params.paneKey,
        params.launchGeneration
      )
    if (updated.changes === 0) {
      db.exec('ROLLBACK')
      return { ok: false, reason: 'no_matching_launch_row' }
    }
    upsertCurrentSession(db, params.hostId, params.paneKey, params.sessionId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    if (isCurrentSessionsSuccessorViolation(err)) {
      return { ok: false, reason: 'foreign_session_id' }
    }
    throw err
  }
  return { ok: true, row: launchBySessionId(db, params.sessionId) as AgentLaunchSessionRow }
}

/** ORDER BY seq DESC — never launch_generation or recorded_at (§7). */
export function newestLaunchForPane(
  db: Database.Database,
  hostId: string,
  paneKey: string
): AgentLaunchSessionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM agent_launch_sessions WHERE host_id = ? AND pane_key = ?
         ORDER BY seq DESC LIMIT 1`
    )
    .get(hostId, paneKey) as AgentLaunchSessionRow | undefined
}

export function launchBySessionId(
  db: Database.Database,
  sessionId: string
): AgentLaunchSessionRow | undefined {
  return db.prepare(`SELECT * FROM agent_launch_sessions WHERE session_id = ?`).get(sessionId) as
    | AgentLaunchSessionRow
    | undefined
}

/** By `seq` (unambiguous) or by the pane's newest row (JUDGMENT CALL: the brief's
 * `setLaunchAgentId(seq|paneKey, agentId)` read as "either form should work" — see RETURN
 * block). */
export function setLaunchAgentId(
  db: Database.Database,
  by: { seq: number } | { hostId: string; paneKey: string },
  agentId: string
): void {
  if ('seq' in by) {
    db.prepare(`UPDATE agent_launch_sessions SET agent_id = ? WHERE seq = ?`).run(agentId, by.seq)
    return
  }
  db.prepare(
    `UPDATE agent_launch_sessions SET agent_id = ?
       WHERE seq = (
         SELECT seq FROM agent_launch_sessions WHERE host_id = ? AND pane_key = ?
           ORDER BY seq DESC LIMIT 1
       )`
  ).run(agentId, by.hostId, by.paneKey)
}

/** [§7, §2.11 N4] Used by retireAgent inside its own new transaction — never called standalone
 * against an uncommitted retire. */
export function deleteLaunchRowsForAgent(db: Database.Database, agentId: string): number {
  const result = db.prepare(`DELETE FROM agent_launch_sessions WHERE agent_id = ?`).run(agentId)
  return Number(result.changes)
}

/** [D-R92 P2] Write side only, called from the sweep's own transaction (C7) before its lock
 * releases. Idempotent (INSERT OR IGNORE). */
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
