// S10-21a C1 (§7, §2.2, §2.11; Ruling 34 Addendum 5): host-authored launch-session provenance.
// Store only — called by C3/C6/C7 and agent-retire.ts, none wired by this commit. Every write
// here is host-local (createTerminal's launch path, the sweep), never peer-writable. Retention
// (pruning + the compensating delete) is agent-launch-sessions-retention.ts; sweep restore marks
// are agent-sweep-restore-marks.ts; the current_sessions upsert is current-session-upsert.ts (a
// dependency both this file and the retention module need, split out to avoid an import cycle
// between them) — all split out to stay under the max-lines budget.
import type Database from '../../sqlite/sync-database'
import { prunePaneRows, pruneGlobalRows } from './agent-launch-sessions-retention'
import { upsertCurrentSession } from './current-session-upsert'

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
  /** [S10-21a C1a, errata 5(p)-5 item 3] Set ONLY from a verified host-resume (Layer-2 restore)
   * admission. Deletes `supersedePaneKey`'s current_sessions row inside this same transaction,
   * before the insert — without it, a restore's recordLaunch(P_new, X) collides with
   * UNIQUE(host_id, session_id) against the still-present (P_pred, X) row and the host's own
   * legitimate restore is refused as a foreign session. C1a provides the mechanism; it does not
   * decide who may set this field — that is C3-v2's admission classification. Every ordinary
   * launch leaves it unset, so the cross-pane UNIQUE stays the successor fence for everything
   * except this one sanctioned pane-to-pane move. */
  supersedePaneKey?: string
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

export type RecordLaunchResult =
  | {
      ok: true
      row: AgentLaunchSessionRow
      /** [D-R104 F-12] True only for the idempotent same-target restatement branch below — this
       * call did not insert `row`, so its caller (admission) must not close confirm/compensate
       * over it (never delete a row it did not insert). */
      restated: boolean
    }
  | ForeignSessionIdRefusal

export type RecordSelfReportRotationResult =
  | { ok: true; row: AgentLaunchSessionRow }
  | ForeignSessionIdRefusal
  | NoMatchingLaunchRowRefusal

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

/** [§2.2] INSERT into agent_launch_sessions + current_sessions upsert, one
 * BEGIN IMMEDIATE…COMMIT. Not best-effort: caller (C3) must refuse the launch loudly on
 * non-ok, never spawn with an unrecorded session id.
 *
 * [errata 5(p)-5 item 6] The §7 prunes run AFTER this transaction commits, each in its own
 * BEGIN IMMEDIATE — a prune that throws does NOT undo the just-recorded launch; the throw
 * propagates out of this call so it is never silently swallowed. */
export function recordLaunch(
  db: Database.Database,
  params: RecordLaunchParams
): RecordLaunchResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (params.supersedePaneKey !== undefined) {
      // [errata 5(p)-5 item 3] Layer-2 restore only — frees the predecessor pane's
      // current_sessions row before the insert so UNIQUE(host_id, session_id) does not refuse
      // the host's own legitimate move of a session from P_pred to P_new.
      db.prepare(`DELETE FROM current_sessions WHERE host_id = ? AND pane_key = ?`).run(
        params.hostId,
        params.supersedePaneKey
      )
    }
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
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    if (isCurrentSessionsSuccessorViolation(err)) {
      // [errata 5(p)-5 item 4, D-R104 F-12] Same-target restatement is an idempotent success:
      // only when the pane CURRENTLY holding this session_id (per current_sessions — the
      // uniqueness fence that just threw) is THIS insert's own pane, and that pane's own newest
      // launch row agrees on session_id AND evidence, is this a no-op restatement of what is
      // already there, rather than a different write (e.g. a different evidence source) racing
      // a genuine collision. A genuinely different pane already holding this session_id is a
      // foreign collision either way.
      //
      // [D-R104 F-4, forced deviation] Deliberately NOT `launchBySessionId` (ambiguous — a
      // session_id can legitimately appear on more than one HISTORICAL agent_launch_sessions
      // row across a host-resume pane move, e.g. the predecessor pane's own now-superseded row;
      // `launchBySessionId` has no ORDER BY and can return either one). Scoped to
      // (hostId, paneKey) instead, which is unambiguous: it is always THIS pane's newest row.
      const conflicting = db
        .prepare(`SELECT pane_key FROM current_sessions WHERE host_id = ? AND session_id = ?`)
        .get(params.hostId, params.sessionId) as { pane_key: string } | undefined
      if (conflicting?.pane_key === params.paneKey) {
        const existing = newestLaunchForPane(db, params.hostId, params.paneKey)
        if (existing?.session_id === params.sessionId && existing.evidence === params.evidence) {
          return { ok: true, row: existing, restated: true }
        }
      }
      return { ok: false, reason: 'foreign_session_id' }
    }
    throw err
  }
  // [D-R104 F-4, forced deviation] Same ambiguity fix as above — this pane's own newest row,
  // not an arbitrary row sharing this session_id.
  const row = newestLaunchForPane(db, params.hostId, params.paneKey) as AgentLaunchSessionRow
  prunePaneRows(db, params.hostId, params.paneKey)
  pruneGlobalRows(db, params.hostId)
  return { ok: true, row, restated: false }
}

/** [§1.6/§2.3] Updates the pane's NEWEST row by seq IN PLACE — never a new row — then upserts
 * current_sessions, same transaction. [errata 5(p)-5 item 2] Targets
 * `WHERE seq = (SELECT seq … ORDER BY seq DESC LIMIT 1)` instead of
 * `(host_id, pane_key, launch_generation)`: dropping that UNIQUE (item 1) means a pane can now
 * carry more than one row per generation, so matching on generation alone no longer identifies
 * the pane's current row. `seq` is left untouched: it was already assigned at the row's original
 * INSERT, after every other row for this pane, so it is already the newest by seq without
 * reassignment. Caller (C6) is expected to have verified §1.6's other three conjuncts; this
 * enforces only the fourth (successor uniqueness). */
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
         WHERE seq = (
           SELECT seq FROM agent_launch_sessions
             WHERE host_id = ? AND pane_key = ?
             ORDER BY seq DESC LIMIT 1
         )`
      )
      .run(params.sessionId, params.previousSessionId, params.hostId, params.paneKey)
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
  // [D-R105 R-3] Same ambiguity fix as recordLaunch above (F-4): `launchBySessionId` has no
  // ORDER BY and can return an unrelated historical row sharing this session_id across a pane
  // move. This UPDATE targets THIS pane's newest row by seq — read it back the same way.
  return {
    ok: true,
    row: newestLaunchForPane(db, params.hostId, params.paneKey) as AgentLaunchSessionRow
  }
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
