// S10-16 R14.6 — split out of link-binding-observations-store.ts (max-lines ratchet, S10-21b
// B15): `peer_link_containment` reads/writes — the durable, peer-immune quarantine/scan_exclude/
// accept_legacy table (Ruling 10/14(c)/R12.3).
import type Database from '../../sqlite/sync-database'

// --- peer_link_containment ----------------------------------------------------------------

export type ContainmentSubjectKind = 'link' | 'environment'
export type ContainmentAction = 'quarantine' | 'scan_exclude' | 'accept_legacy'

export type ContainmentRow = {
  subjectKind: ContainmentSubjectKind
  subjectId: string
  action: ContainmentAction
  reasonCode: string | null
  reasonText: string | null
  detail: string | null
  createdAt: number
  expiresAt: number | null
  liftedAt: number | null
}

type ContainmentSqlRow = {
  subject_kind: ContainmentSubjectKind
  subject_id: string
  action: ContainmentAction
  reason_code: string | null
  reason_text: string | null
  detail: string | null
  created_at: number
  expires_at: number | null
  lifted_at: number | null
}

function fromSqlContainmentRow(row: ContainmentSqlRow): ContainmentRow {
  return {
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    action: row.action,
    reasonCode: row.reason_code,
    reasonText: row.reason_text,
    detail: row.detail,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    liftedAt: row.lifted_at
  }
}

export function getContainment(
  db: Database.Database,
  subjectKind: ContainmentSubjectKind,
  subjectId: string,
  action: ContainmentAction
): ContainmentRow | null {
  const row = db
    .prepare(
      'SELECT * FROM peer_link_containment WHERE subject_kind = ? AND subject_id = ? AND action = ?'
    )
    .get(subjectKind, subjectId, action) as ContainmentSqlRow | undefined
  return row ? fromSqlContainmentRow(row) : null
}

export function listContainment(db: Database.Database): ContainmentRow[] {
  const rows = db.prepare('SELECT * FROM peer_link_containment').all() as ContainmentSqlRow[]
  return rows.map(fromSqlContainmentRow)
}

// R10-A / R15: is this link currently quarantined (a live, unlifted, unexpired quarantine row)?
// Review F2 / design R3 (s10-16-design-link-binding-v6.md:880-883): a time-boxed quarantine must
// stop refusing once past its own `expires_at` — omitting this clause left an operator's expiry
// silently inert (fail-closed, not a security hole, but a live row that never actually lifts).
export function isPeerLinkQuarantined(db: Database.Database, linkDeviceId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM peer_link_containment
        WHERE subject_kind = 'link' AND subject_id = ? AND action = 'quarantine' AND lifted_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)`
    )
    .get(linkDeviceId, Date.now())
  return row !== undefined
}

// R14.7 (Ruling 17(o)): re-assertion is an UPSERT on the PK — no new PK needed for lift→re-assert.
// `peer_link_containment` is EXEMPT from the row cap (R14.5) — a safety table must never fail open.
export function putContainment(db: Database.Database, row: Omit<ContainmentRow, 'liftedAt'>): void {
  db.prepare(
    `INSERT INTO peer_link_containment (
       subject_kind, subject_id, action, reason_code, reason_text, detail,
       created_at, expires_at, lifted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(subject_kind, subject_id, action) DO UPDATE SET
       lifted_at = NULL, created_at = excluded.created_at, expires_at = excluded.expires_at,
       reason_code = excluded.reason_code, reason_text = excluded.reason_text, detail = excluded.detail`
  ).run(
    row.subjectKind,
    row.subjectId,
    row.action,
    row.reasonCode,
    row.reasonText,
    row.detail,
    row.createdAt,
    row.expiresAt
  )
}

export function liftContainment(
  db: Database.Database,
  subjectKind: ContainmentSubjectKind,
  subjectId: string,
  action: ContainmentAction,
  now: number
): void {
  db.prepare(
    `UPDATE peer_link_containment
        SET lifted_at = ?
      WHERE subject_kind = ? AND subject_id = ? AND action = ? AND lifted_at IS NULL`
  ).run(now, subjectKind, subjectId, action)
}

// R13.4: the sweep's own retention purge — bindings, attempts, facts and confirm observations
// for links NOT IN the currently-live runtime-scope device id set (containment is deliberately
// excluded — operator intent must survive a sweep the same way it survives resetAll, R14.3).
// Distinct from `deleteBindingsAndAttemptsIn` below (link-forget's OPERATOR-NAMED purge) — this
// one's caller (link-binding-prover-maintenance.ts) genuinely needs exclusion-from-a-retained-set
// semantics: "delete everything the registry no longer knows about."
export function deleteBindingsAndAttemptsNotIn(
  db: Database.Database,
  retainedLinkDeviceIds: readonly string[]
): void {
  const placeholders = retainedLinkDeviceIds.map(() => '?').join(',') || "''"
  const args = retainedLinkDeviceIds.length > 0 ? retainedLinkDeviceIds : []
  for (const table of [
    'peer_link_bindings',
    'peer_link_attempts',
    'peer_link_scan_facts',
    'peer_link_confirm_observations'
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE link_device_id NOT IN (${placeholders})`).run(...args)
  }
}

// R5.1/Ruling 28(h)/protocol F9: per-row purge surface for `orca environment link-forget` —
// bindings, attempts, facts and confirm observations for links IN the forgotten set. Deletes by
// INCLUSION over the caller's own `forgotten` id list — never by exclusion from a possibly-
// incomplete `retained` set — so a link the caller's own enumeration missed (or a row inserted
// between that read and this write) can never be swept up by accident (protocol F9).
export function deleteBindingsAndAttemptsIn(
  db: Database.Database,
  forgottenLinkDeviceIds: readonly string[]
): void {
  if (forgottenLinkDeviceIds.length === 0) {
    return
  }
  const placeholders = forgottenLinkDeviceIds.map(() => '?').join(',')
  for (const table of [
    'peer_link_bindings',
    'peer_link_attempts',
    'peer_link_scan_facts',
    'peer_link_confirm_observations'
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE link_device_id IN (${placeholders})`).run(
      ...forgottenLinkDeviceIds
    )
  }
}
