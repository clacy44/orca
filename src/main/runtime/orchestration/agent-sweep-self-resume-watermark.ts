// S10-21a C7j (Ruling 34 Addendum 27, row 7): "a self-resume audited since this process started
// holds the leaf." Two pure reads against `agent_audit`, no writes, no schema change — split out
// to stay under the repo's max-lines ratchet for new source files, mirroring
// agent-sweep-unrecorded-check.ts's own shape (pane-suffix query against ADMISSION_AUDIT_VERBS).
import type Database from '../../sqlite/sync-database'

/** The watermark itself: the newest `agent_audit` row's `seq` at the moment it is captured (ANY
 * verb — a floor for "since this process started", not scoped to self-resume rows; the
 * self-resume scoping is `newestSelfResumeAuditForPane`'s own WHERE clause). Captured once, by
 * the caller (orca-runtime.ts's `captureSelfResumeWatermark`), before openMainWindow, under the
 * restore-sweep lock. Null on an empty table (no audit rows have ever been written) — the sweep
 * treats that the same as any other watermark value, never as "absent"; only a db that was never
 * peeked at all (no attach yet at the capture point) produces the caller's absent case. */
export function newestAgentAuditSeq(db: Database.Database): number | null {
  const row = db.prepare('SELECT MAX(seq) AS seq FROM agent_audit').get() as
    | { seq: number | null }
    | undefined
  return row?.seq ?? null
}

export type SelfResumeAuditHit = { seq: number }

/** Row 7's own DB read: the newest `launch_self_resume` audit for this exact pane (matched by
 * SUFFIX, same rule as `isNewestAdmissionUnrecordedAndNewer`/`newestLaunchForPaneSuffix`) written
 * strictly after `afterSeq` (the captured watermark) — i.e. audited since this process started,
 * never a self-resume from a prior process's lifetime. `hostId` scopes to the actor's own host,
 * matching `actor_host_id` as written by `agent-launch-admission-support.ts`'s `audit()`. */
export function newestSelfResumeAuditForPane(
  db: Database.Database,
  hostId: string,
  paneKeySuffix: string,
  afterSeq: number
): SelfResumeAuditHit | null {
  const row = db
    .prepare(
      `SELECT seq FROM agent_audit
         WHERE actor_host_id = ?
           AND substr(actor_pane_key, instr(actor_pane_key, ':') + 1) = ?
           AND verb = 'launch_self_resume'
           AND seq > ?
         ORDER BY seq DESC LIMIT 1`
    )
    .get(hostId, paneKeySuffix, afterSeq) as { seq: number } | undefined
  return row ? { seq: row.seq } : null
}
