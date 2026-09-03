// S10-16 R14.6: SQL for peer_link_attempts — schedule/backoff/health/advisory bookkeeping, one
// row per candidate link — over `Database.Database`. Split out of link-binding-store.ts (plan
// §7.6) to stay under max-lines; imports LinkBindingCapError from there rather than duplicating it.
import type Database from '../../sqlite/sync-database'
import { LINK_BINDING_ROWS_CAP } from './link-binding-constants'
import { LinkBindingCapError } from './link-binding-store'

export type LinkBindingLastOutcome =
  | 'pending'
  | 'proven'
  | 'unpaired'
  | 'unpaired_parked'
  | 'peer_duplicate'
  | 'duplicate_environment'
  | 'multi_grant'
  | 'contested'
  | 'unreachable'
  | 'unsupported'
  | 'unavailable'
  | 'protocol_violation'
  | 'quarantined'
  | 'revoked'
  | 'excluded'

export type LinkAdvisory = {
  kind: 'link_contested' | 'link_quarantined' | 'peer_reports_contest' | 'authorship_unconfirmed'
  incidentId?: string
  environmentId?: string
  outboxId?: string
}

export type BindingAttemptRow = {
  linkDeviceId: string
  lastAttemptAt: number | null
  lastRoundAt: number | null
  lastFullRoundAt: number | null
  lastOutcome: LinkBindingLastOutcome
  lastDetail: string | null
  lastAdvisory: LinkAdvisory | null
  lastAdvisoryAt: number | null
  consecutiveFailures: number
  consecutiveNoWinner: number
  misrouteAdvisories: number
  nextAttemptAfter: number | null
}

type BindingAttemptSqlRow = {
  link_device_id: string
  last_attempt_at: number | null
  last_round_at: number | null
  last_full_round_at: number | null
  last_outcome: LinkBindingLastOutcome
  last_detail: string | null
  last_advisory: string | null
  last_advisory_at: number | null
  consecutive_failures: number
  consecutive_no_winner: number
  misroute_advisories: number
  next_attempt_after: number | null
}

function fromSqlAttemptRow(row: BindingAttemptSqlRow): BindingAttemptRow {
  return {
    linkDeviceId: row.link_device_id,
    lastAttemptAt: row.last_attempt_at,
    lastRoundAt: row.last_round_at,
    lastFullRoundAt: row.last_full_round_at,
    lastOutcome: row.last_outcome,
    lastDetail: row.last_detail,
    lastAdvisory: row.last_advisory ? (JSON.parse(row.last_advisory) as LinkAdvisory) : null,
    lastAdvisoryAt: row.last_advisory_at,
    consecutiveFailures: row.consecutive_failures,
    consecutiveNoWinner: row.consecutive_no_winner,
    misrouteAdvisories: row.misroute_advisories,
    nextAttemptAfter: row.next_attempt_after
  }
}

export function getBindingAttempt(
  db: Database.Database,
  linkDeviceId: string
): BindingAttemptRow | null {
  const row = db
    .prepare('SELECT * FROM peer_link_attempts WHERE link_device_id = ?')
    .get(linkDeviceId) as BindingAttemptSqlRow | undefined
  return row ? fromSqlAttemptRow(row) : null
}

export function listBindingAttempts(db: Database.Database): BindingAttemptRow[] {
  const rows = db.prepare('SELECT * FROM peer_link_attempts').all() as BindingAttemptSqlRow[]
  return rows.map(fromSqlAttemptRow)
}

// Ensures a row exists for a candidate link — the round-start write (R14.2). R14.5: capped like
// peer_link_bindings.
export function putBindingAttempt(db: Database.Database, linkDeviceId: string): void {
  if (getBindingAttempt(db, linkDeviceId) === null) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM peer_link_attempts').get() as { n: number }
    if (count.n >= LINK_BINDING_ROWS_CAP) {
      throw new LinkBindingCapError('peer_link_attempts')
    }
  }
  db.prepare(
    `INSERT INTO peer_link_attempts (link_device_id) VALUES (?)
     ON CONFLICT(link_device_id) DO NOTHING`
  ).run(linkDeviceId)
}

export type BindingAttemptSettle = {
  lastAttemptAt: number
  lastRoundAt: number
  lastFullRoundAt?: number
  lastOutcome: LinkBindingLastOutcome
  lastDetail: string | null
  consecutiveFailures: number
  consecutiveNoWinner: number
  nextAttemptAfter: number | null
}

// R14.2: exactly one writer of last_outcome — the round settle.
export function settleBindingAttempt(
  db: Database.Database,
  linkDeviceId: string,
  s: BindingAttemptSettle
): void {
  db.prepare(
    `UPDATE peer_link_attempts
        SET last_attempt_at = ?, last_round_at = ?,
            last_full_round_at = COALESCE(?, last_full_round_at),
            last_outcome = ?, last_detail = ?,
            consecutive_failures = ?, consecutive_no_winner = ?, next_attempt_after = ?
      WHERE link_device_id = ?`
  ).run(
    s.lastAttemptAt,
    s.lastRoundAt,
    s.lastFullRoundAt ?? null,
    s.lastOutcome,
    s.lastDetail,
    s.consecutiveFailures,
    s.consecutiveNoWinner,
    s.nextAttemptAfter,
    linkDeviceId
  )
}

// v5 P5: two host-side writers only — the verifier round (link_contested/link_quarantined
// advisories) and the outbox pump (authorship_unconfirmed). Never last_outcome.
export function putLinkAdvisory(
  db: Database.Database,
  linkDeviceId: string,
  advisory: LinkAdvisory,
  now: number
): void {
  db.prepare(
    `UPDATE peer_link_attempts SET last_advisory = ?, last_advisory_at = ? WHERE link_device_id = ?`
  ).run(JSON.stringify(advisory), now, linkDeviceId)
}

// v6 protocol M2 / lifecycle M1 / Ruling 23(a): the clearing writer both the pump (clean
// delivery) and proveNow use — misroute_advisories, last_advisory, last_advisory_at all clear
// together. `last_advisory_notified_at` does not exist in the v40 DDL (C2 amendment (i)); the
// authorship-family dedupe this column used to back now lives in `shouldFireReplyRelayNotice`
// (per-(link, incidentId, code), against `peer_reply_outbox.notified_at` — plan §3.1 P-4), not
// in this table.
export function clearLinkAdvisory(db: Database.Database, linkDeviceId: string): void {
  db.prepare(
    `UPDATE peer_link_attempts
        SET misroute_advisories = 0, last_advisory = NULL, last_advisory_at = NULL
      WHERE link_device_id = ?`
  ).run(linkDeviceId)
}

export function bumpMisrouteAdvisories(db: Database.Database, linkDeviceId: string): void {
  db.prepare(
    `UPDATE peer_link_attempts SET misroute_advisories = misroute_advisories + 1 WHERE link_device_id = ?`
  ).run(linkDeviceId)
}
