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
  // S10-21b B15 (design §3.3, errata NB2): stamped on the FIRST scan of an episode that
  // transitions INTO 'unreachable' (previous outcome was something else, or no row existed);
  // left untouched on every subsequent 'unreachable' scan; cleared to null on any other outcome.
  // Derived by `putScanFact`, never caller-supplied — see `ScanFactWriteRow` below.
  unreachableSince: number | null
  // S10-21b B17 (D-R137 F4, D-R138 F3): the mirror rule for RECOVERY — stamped on the FIRST scan
  // that transitions OUT of 'unreachable' (previous outcome was 'unreachable' or no row
  // existed); left untouched on every subsequent non-'unreachable' scan; cleared to null on
  // 'unreachable'. Anchors auto-resume on continuous recovery, never a single good scan.
  reachableSince: number | null
}

// The write-side shape `writeScanFact`/callers construct: `unreachableSince`/`reachableSince` are
// NEVER supplied by a caller — `putScanFact` derives both from the prior row.
export type ScanFactWriteRow = Omit<ScanFactRow, 'unreachableSince' | 'reachableSince'>

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
        unreachable_since: number | null
        reachable_since: number | null
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
        observedAt: row.observed_at,
        unreachableSince: row.unreachable_since,
        reachableSince: row.reachable_since
      }
    : null
}

// Ruling 28(h)/protocol F9 (C8a): distinct link ids holding a scan-fact row — `linkForget`'s id
// set must cover this table too, not only bindings/attempts/containment.
export function listScanFactLinkIds(db: Database.Database): string[] {
  const rows = db
    .prepare('SELECT DISTINCT link_device_id AS id FROM peer_link_scan_facts')
    .all() as {
    id: string
  }[]
  return rows.map((row) => row.id)
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
    unreachable_since: number | null
    reachable_since: number | null
  }[]
  return rows.map((row) => ({
    linkDeviceId: row.link_device_id,
    environmentId: row.environment_id,
    outcome: row.outcome,
    environmentPairingRevision: row.environment_pairing_revision,
    linkCredentialFp: row.link_credential_fp,
    detail: row.detail,
    observedAt: row.observed_at,
    unreachableSince: row.unreachable_since,
    reachableSince: row.reachable_since
  }))
}

// R12: single writer, the verifier round. Ruling 23(d) — the collapse writes NO scan fact for a
// dropped duplicate; callers must never invoke this for a collapsed candidate.
// S10-21b B15 (design §3.3, errata NB2): derives `unreachable_since` from the PRIOR row here —
// the write rule's one enforcement point. Set on the first scan of an episode that transitions
// INTO 'unreachable' (prior outcome was something else, or no row existed); untouched on a
// repeat 'unreachable' scan of the same episode; cleared to NULL on any other outcome.
export function putScanFact(db: Database.Database, row: ScanFactWriteRow): void {
  const prior = getScanFact(db, row.linkDeviceId, row.environmentId)
  if (prior === null) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM peer_link_scan_facts').get() as {
      n: number
    }
    if (count.n >= LINK_BINDING_SCAN_FACTS_CAP) {
      throw new LinkBindingCapError('peer_link_scan_facts')
    }
  }
  const unreachableSince =
    row.outcome !== 'unreachable'
      ? null
      : prior !== null && prior.outcome === 'unreachable'
        ? prior.unreachableSince
        : row.observedAt
  // S10-21b B17 (D-R137 F4, D-R138 F3): the mirror of the NB2 rule above, for RECOVERY. Set on
  // the first scan that transitions OUT of 'unreachable' (prior outcome was 'unreachable', or no
  // row existed — a fresh non-'unreachable' row starts its own recovery episode from birth);
  // held across repeats of the SAME non-'unreachable' episode; cleared to NULL on 'unreachable'.
  const reachableSince =
    row.outcome === 'unreachable'
      ? null
      : prior !== null && prior.outcome !== 'unreachable'
        ? prior.reachableSince
        : row.observedAt
  db.prepare(
    `INSERT INTO peer_link_scan_facts (
       link_device_id, environment_id, outcome, environment_pairing_revision,
       link_credential_fp, detail, observed_at, unreachable_since, reachable_since
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(link_device_id, environment_id) DO UPDATE SET
       outcome = excluded.outcome,
       environment_pairing_revision = excluded.environment_pairing_revision,
       link_credential_fp = excluded.link_credential_fp,
       detail = excluded.detail, observed_at = excluded.observed_at,
       unreachable_since = excluded.unreachable_since,
       reachable_since = excluded.reachable_since`
  ).run(
    row.linkDeviceId,
    row.environmentId,
    row.outcome,
    row.environmentPairingRevision,
    row.linkCredentialFp,
    row.detail,
    row.observedAt,
    unreachableSince,
    reachableSince
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

// Ruling 28(h)/protocol F9 (C8a): distinct link ids holding a confirm-observation row — the one
// table a peer's own call can create rows in, so `linkForget`'s id set must cover it too.
export function listConfirmObservationLinkIds(db: Database.Database): string[] {
  const rows = db
    .prepare('SELECT DISTINCT link_device_id AS id FROM peer_link_confirm_observations')
    .all() as { id: string }[]
  return rows.map((row) => row.id)
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

// Split out to peer-link-containment-store.ts (max-lines ratchet, S10-21b B15); re-exported so
// every existing importer of this module is unaffected.
export type {
  ContainmentSubjectKind,
  ContainmentAction,
  ContainmentRow
} from './peer-link-containment-store'
export {
  getContainment,
  listContainment,
  isPeerLinkQuarantined,
  putContainment,
  liftContainment,
  deleteBindingsAndAttemptsNotIn,
  deleteBindingsAndAttemptsIn
} from './peer-link-containment-store'
