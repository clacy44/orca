// S10-16 R14.6: SQL for peer_link_scan_facts, peer_link_confirm_observations and
// peer_link_containment — over `Database.Database`. Split out of link-binding-store.ts (plan
// §7.6) to stay under max-lines; imports LinkBindingCapError from there rather than duplicating it.
import type Database from '../../sqlite/sync-database'
import {
  LINK_BINDING_SCAN_FACTS_CAP,
  LINK_BINDING_CONFIRM_OBS_PER_LINK_CAP
} from './link-binding-constants'
import { LinkBindingCapError } from './link-binding-store'

export type LinkScanFactOutcome =
  | 'no_match'
  | 'proven'
  | 'peer_duplicate'
  | 'protocol_violation'
  | 'unsupported'
  | 'unavailable'
  | 'unreachable'

export type ScanFactRow = {
  linkDeviceId: string
  environmentId: string
  outcome: LinkScanFactOutcome
  environmentPairingRevision: number
  linkCredentialFp: string
  detail: string | null
  observedAt: number
}

export function getScanFact(
  db: Database.Database,
  linkDeviceId: string,
  environmentId: string
): ScanFactRow | null {
  const row = db
    .prepare('SELECT * FROM peer_link_scan_facts WHERE link_device_id = ? AND environment_id = ?')
    .get(linkDeviceId, environmentId) as
    | {
        link_device_id: string
        environment_id: string
        outcome: LinkScanFactOutcome
        environment_pairing_revision: number
        link_credential_fp: string
        detail: string | null
        observed_at: number
      }
    | undefined
  return row
    ? {
        linkDeviceId: row.link_device_id,
        environmentId: row.environment_id,
        outcome: row.outcome,
        environmentPairingRevision: row.environment_pairing_revision,
        linkCredentialFp: row.link_credential_fp,
        detail: row.detail,
        observedAt: row.observed_at
      }
    : null
}

export function listScanFacts(db: Database.Database, linkDeviceId: string): ScanFactRow[] {
  const rows = db
    .prepare('SELECT * FROM peer_link_scan_facts WHERE link_device_id = ?')
    .all(linkDeviceId) as {
    link_device_id: string
    environment_id: string
    outcome: LinkScanFactOutcome
    environment_pairing_revision: number
    link_credential_fp: string
    detail: string | null
    observed_at: number
  }[]
  return rows.map((row) => ({
    linkDeviceId: row.link_device_id,
    environmentId: row.environment_id,
    outcome: row.outcome,
    environmentPairingRevision: row.environment_pairing_revision,
    linkCredentialFp: row.link_credential_fp,
    detail: row.detail,
    observedAt: row.observed_at
  }))
}

// R12: single writer, the verifier round. Ruling 23(d) — the collapse writes NO scan fact for a
// dropped duplicate; callers must never invoke this for a collapsed candidate.
export function putScanFact(db: Database.Database, row: ScanFactRow): void {
  if (getScanFact(db, row.linkDeviceId, row.environmentId) === null) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM peer_link_scan_facts').get() as {
      n: number
    }
    if (count.n >= LINK_BINDING_SCAN_FACTS_CAP) {
      throw new LinkBindingCapError('peer_link_scan_facts')
    }
  }
  db.prepare(
    `INSERT INTO peer_link_scan_facts (
       link_device_id, environment_id, outcome, environment_pairing_revision,
       link_credential_fp, detail, observed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(link_device_id, environment_id) DO UPDATE SET
       outcome = excluded.outcome,
       environment_pairing_revision = excluded.environment_pairing_revision,
       link_credential_fp = excluded.link_credential_fp,
       detail = excluded.detail, observed_at = excluded.observed_at`
  ).run(
    row.linkDeviceId,
    row.environmentId,
    row.outcome,
    row.environmentPairingRevision,
    row.linkCredentialFp,
    row.detail,
    row.observedAt
  )
}

// --- peer_link_confirm_observations -----------------------------------------------------------

export type ConfirmObservationKind = 'peer_confirmed' | 'local_duplicate'

export type ConfirmObservationRow = {
  linkDeviceId: string
  environmentId: string
  kind: ConfirmObservationKind
  detail: string | null
  observedAt: number
}

export function listConfirmObservations(
  db: Database.Database,
  linkDeviceId: string
): ConfirmObservationRow[] {
  const rows = db
    .prepare('SELECT * FROM peer_link_confirm_observations WHERE link_device_id = ?')
    .all(linkDeviceId) as {
    link_device_id: string
    environment_id: string
    kind: ConfirmObservationKind
    detail: string | null
    observed_at: number
  }[]
  return rows.map((row) => ({
    linkDeviceId: row.link_device_id,
    environmentId: row.environment_id,
    kind: row.kind,
    detail: row.detail,
    observedAt: row.observed_at
  }))
}

// Ruling 17(g): the ONLY table a peer's own RPC call causes a row in — per-link capped (INV-P-006).
export function putConfirmObservation(db: Database.Database, row: ConfirmObservationRow): void {
  const count = db
    .prepare('SELECT COUNT(*) AS n FROM peer_link_confirm_observations WHERE link_device_id = ?')
    .get(row.linkDeviceId) as { n: number }
  if (count.n >= LINK_BINDING_CONFIRM_OBS_PER_LINK_CAP) {
    throw new LinkBindingCapError('peer_link_confirm_observations')
  }
  db.prepare(
    `INSERT INTO peer_link_confirm_observations (
       link_device_id, environment_id, kind, detail, observed_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(link_device_id, environment_id, kind) DO UPDATE SET
       detail = excluded.detail, observed_at = excluded.observed_at`
  ).run(row.linkDeviceId, row.environmentId, row.kind, row.detail, row.observedAt)
}

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

// R5.1: per-row purge surface for `orca environment link-forget` — bindings, attempts, facts and
// confirm observations for links NOT IN the retained set (containment is deliberately excluded —
// operator intent must survive a link-forget the same way it survives resetAll, R14.3).
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
