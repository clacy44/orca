// S10-16 R14.6: SQL for peer_link_bindings — the durable proof-of-correspondence rows — over
// `Database.Database`. Split from the attempts/observations stores to stay under max-lines
// (plan §7.6): peer_link_attempts is link-binding-attempts-store.ts; peer_link_scan_facts /
// peer_link_confirm_observations / peer_link_containment are link-binding-observations-store.ts.
import type Database from '../../sqlite/sync-database'
import { LINK_BINDING_ROWS_CAP } from './link-binding-constants'

export type LinkBindingGrantClass = 'minted' | 'legacy_coalesced'
export type LinkBindingScanCompleteness = 'complete' | 'partial'
export type LinkBindingState = 'confirmed' | 'contested' | 'revoked'

export type PeerLinkBindingRow = {
  linkDeviceId: string
  environmentId: string
  boundEndpointId: string
  boundPairingRevision: number
  linkCredentialFp: string
  peerCredentialFp: string
  peerKeyFingerprint: string
  grantClass: LinkBindingGrantClass
  scanCompleteness: LinkBindingScanCompleteness
  proofProtocol: string
  state: LinkBindingState
  detail: string | null
  contestIncidentId: string | null
  provedAt: number
  lastVerifiedAt: number
  contestedAt: number | null
  revokedAt: number | null
}

type PeerLinkBindingSqlRow = {
  link_device_id: string
  environment_id: string
  bound_endpoint_id: string
  bound_pairing_revision: number
  link_credential_fp: string
  peer_credential_fp: string
  peer_key_fingerprint: string
  grant_class: LinkBindingGrantClass
  scan_completeness: LinkBindingScanCompleteness
  proof_protocol: string
  state: LinkBindingState
  detail: string | null
  contest_incident_id: string | null
  proved_at: number
  last_verified_at: number
  contested_at: number | null
  revoked_at: number | null
}

function fromSqlBindingRow(row: PeerLinkBindingSqlRow): PeerLinkBindingRow {
  return {
    linkDeviceId: row.link_device_id,
    environmentId: row.environment_id,
    boundEndpointId: row.bound_endpoint_id,
    boundPairingRevision: row.bound_pairing_revision,
    linkCredentialFp: row.link_credential_fp,
    peerCredentialFp: row.peer_credential_fp,
    peerKeyFingerprint: row.peer_key_fingerprint,
    grantClass: row.grant_class,
    scanCompleteness: row.scan_completeness,
    proofProtocol: row.proof_protocol,
    state: row.state,
    detail: row.detail,
    contestIncidentId: row.contest_incident_id,
    provedAt: row.proved_at,
    lastVerifiedAt: row.last_verified_at,
    contestedAt: row.contested_at,
    revokedAt: row.revoked_at
  }
}

export function getPeerLinkBinding(
  db: Database.Database,
  linkDeviceId: string
): PeerLinkBindingRow | null {
  const row = db
    .prepare('SELECT * FROM peer_link_bindings WHERE link_device_id = ?')
    .get(linkDeviceId) as PeerLinkBindingSqlRow | undefined
  return row ? fromSqlBindingRow(row) : null
}

export function listPeerLinkBindings(db: Database.Database): PeerLinkBindingRow[] {
  const rows = db.prepare('SELECT * FROM peer_link_bindings').all() as PeerLinkBindingSqlRow[]
  return rows.map(fromSqlBindingRow)
}

// R14.2: the verifier round's own write. A fresh proof always resets state to 'confirmed' and
// clears any contest/revoke bookkeeping — safe because a revoked link is excluded from the
// candidate set (R10-A, revoke is sticky) and a contested link's re-proof resolving to one
// winner is exactly how a contest is meant to clear.
//
// Ruling 23 Addendum 4(aa)/review C4b finding 1(b): the caller (link-binding-prover-settle.ts)
// already never reaches this function for a contested link's mismatched winner — but the ON
// CONFLICT below preserves an existing contest STRUCTURALLY too, at the SQL level, so "the
// settle never overwrites a contest with confirmed" (Ruling 23(r)) is a property of the writer,
// not only of its one caller. The only path that clears `state='contested'` is the host-side
// contest-resolution verb (`proveNow`, which calls `contestPeerLinkBinding`'s sibling reset —
// out of this commit's scope) or a fresh proof that genuinely re-resolves to a single winner
// while the row is NOT currently contested.
export function putPeerLinkBinding(
  db: Database.Database,
  row: Omit<
    PeerLinkBindingRow,
    'state' | 'detail' | 'contestIncidentId' | 'contestedAt' | 'revokedAt'
  >
): void {
  if (getPeerLinkBinding(db, row.linkDeviceId) === null) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM peer_link_bindings').get() as { n: number }
    if (count.n >= LINK_BINDING_ROWS_CAP) {
      throw new LinkBindingCapError('peer_link_bindings')
    }
  }
  db.prepare(
    `INSERT INTO peer_link_bindings (
       link_device_id, environment_id, bound_endpoint_id, bound_pairing_revision,
       link_credential_fp, peer_credential_fp, peer_key_fingerprint, grant_class,
       scan_completeness, proof_protocol, state, detail, contest_incident_id,
       proved_at, last_verified_at, contested_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', NULL, NULL, ?, ?, NULL, NULL)
     ON CONFLICT(link_device_id) DO UPDATE SET
       environment_id = excluded.environment_id,
       bound_endpoint_id = excluded.bound_endpoint_id,
       bound_pairing_revision = excluded.bound_pairing_revision,
       link_credential_fp = excluded.link_credential_fp,
       peer_credential_fp = excluded.peer_credential_fp,
       peer_key_fingerprint = excluded.peer_key_fingerprint,
       grant_class = excluded.grant_class,
       scan_completeness = excluded.scan_completeness,
       proof_protocol = excluded.proof_protocol,
       -- structural contest guard (see the doc comment above): an existing contest survives
       -- this write regardless of caller discipline. 'confirmed' only when the row was not
       -- already 'contested'.
       state = CASE WHEN peer_link_bindings.state = 'contested' THEN 'contested' ELSE 'confirmed' END,
       detail = CASE WHEN peer_link_bindings.state = 'contested' THEN peer_link_bindings.detail ELSE NULL END,
       contest_incident_id = CASE WHEN peer_link_bindings.state = 'contested'
         THEN peer_link_bindings.contest_incident_id ELSE NULL END,
       proved_at = excluded.proved_at, last_verified_at = excluded.last_verified_at,
       contested_at = CASE WHEN peer_link_bindings.state = 'contested'
         THEN peer_link_bindings.contested_at ELSE NULL END,
       revoked_at = NULL`
  ).run(
    row.linkDeviceId,
    row.environmentId,
    row.boundEndpointId,
    row.boundPairingRevision,
    row.linkCredentialFp,
    row.peerCredentialFp,
    row.peerKeyFingerprint,
    row.grantClass,
    row.scanCompleteness,
    row.proofProtocol,
    row.provedAt,
    row.lastVerifiedAt
  )
}

// Review F6: the ONE truth for the `link_binding_conflict` wire code (rpc/errors.ts's
// STRUCTURED_RUNTIME_PASSTHROUGH_CODES matches on `.code`, never on `.message`) — every capped
// table throws this and its `.code` is what makes it a passthrough rather than a collapsed
// `runtime_error` wherever it is allowed to propagate unswallowed (R16/R14.5:
// reply-outbox-store.ts's REPLY_OUTBOX_PER_LINK_CAP is the live site in this tree; C3's own two
// call sites deliberately swallow it as a soft degrade, per R14.5's "acknowledgement still
// stands" rule).
export class LinkBindingCapError extends Error {
  readonly code = 'link_binding_conflict'
  constructor(readonly table: string) {
    super(`link_binding_conflict: ${table} at capacity`)
  }
}

// R11.3: the ONE writer of state='contested'. No wire code from any peer can reach this (INV-P-012).
//
// Ruling 23 Addendum 5(jj)/review C4c finding 1: a contest MUST produce a binding row even when
// no incumbent exists — R11.3's own canonical case (two winners, different key fingerprints, a
// link this host has never bound). `firstWinner` supplies the host-derived fields (from the
// round's first winner — never anything peer-supplied beyond what a normal `bind` write would
// already accept) an INSERT needs to satisfy the table's NOT NULL columns; they are used ONLY on
// the insert branch. The `WHERE state <> 'contested'` guard makes the whole write a no-op once
// the row is already contested — the proof-bearing columns (and the contest markers themselves)
// stay immutable to every writer except the host-side contest-resolution verb, matching
// `putPeerLinkBinding`'s own structural guard above.
export type ContestFirstWinner = {
  environmentId: string
  boundEndpointId: string
  boundPairingRevision: number
  linkCredentialFp: string
  peerCredentialFp: string
  peerKeyFingerprint: string
  grantClass: 'minted' | 'legacy_coalesced'
  scanCompleteness: 'complete' | 'partial'
  proofProtocol: string
}

export function contestPeerLinkBinding(
  db: Database.Database,
  linkDeviceId: string,
  now: number,
  incidentId: string,
  detail: string | null,
  firstWinner: ContestFirstWinner
): void {
  // Ruling 23 Addendum 6(tt)/review C4d finding 3: the same pre-check `putPeerLinkBinding` runs —
  // only when this INSERT would create a NEW row (an existing row is an UPDATE, no growth) — and
  // the same refusal code (LinkBindingCapError -> 'link_binding_conflict').
  if (getPeerLinkBinding(db, linkDeviceId) === null) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM peer_link_bindings').get() as { n: number }
    if (count.n >= LINK_BINDING_ROWS_CAP) {
      throw new LinkBindingCapError('peer_link_bindings')
    }
  }
  // Ruling 23 Addendum 6(vv)/review C4d finding 8: the upsert guard below admits ONLY a
  // currently-confirmed row -- narrower than the prior "not already contested" predicate (which
  // also admitted a revoked row). A revoked row is never flipped back to contested in place.
  db.prepare(
    `INSERT INTO peer_link_bindings (
       link_device_id, environment_id, bound_endpoint_id, bound_pairing_revision,
       link_credential_fp, peer_credential_fp, peer_key_fingerprint, grant_class,
       scan_completeness, proof_protocol, state, detail, contest_incident_id,
       proved_at, last_verified_at, contested_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'contested', ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(link_device_id) DO UPDATE SET
       state = 'contested',
       detail = excluded.detail,
       contest_incident_id = excluded.contest_incident_id,
       contested_at = excluded.contested_at
     WHERE peer_link_bindings.state = 'confirmed'`
  ).run(
    linkDeviceId,
    firstWinner.environmentId,
    firstWinner.boundEndpointId,
    firstWinner.boundPairingRevision,
    firstWinner.linkCredentialFp,
    firstWinner.peerCredentialFp,
    firstWinner.peerKeyFingerprint,
    firstWinner.grantClass,
    firstWinner.scanCompleteness,
    firstWinner.proofProtocol,
    detail,
    incidentId,
    now,
    now,
    now
  )
}

export function revokePeerLinkBinding(
  db: Database.Database,
  linkDeviceId: string,
  now: number
): void {
  db.prepare(
    `UPDATE peer_link_bindings SET state = 'revoked', revoked_at = ? WHERE link_device_id = ?`
  ).run(now, linkDeviceId)
}

export function findBindingsByEnvironment(
  db: Database.Database,
  environmentId: string
): PeerLinkBindingRow[] {
  const rows = db
    .prepare('SELECT * FROM peer_link_bindings WHERE environment_id = ?')
    .all(environmentId) as PeerLinkBindingSqlRow[]
  return rows.map(fromSqlBindingRow)
}

// R18.4(b): the retarget lookup — the only routable binding, if any, matching a peer key.
// Review F16: INV-P-008 makes >=2 confirmed rows under one key a contest, not a route choice —
// ORDER BY makes the (should-be-impossible) pick deterministic rather than SQLite's unspecified
// `LIMIT 1` row order.
export function findRoutableBindingByKeyFingerprint(
  db: Database.Database,
  peerKeyFingerprint: string
): PeerLinkBindingRow | null {
  const row = db
    .prepare(
      `SELECT * FROM peer_link_bindings
        WHERE peer_key_fingerprint = ? AND state = 'confirmed' AND revoked_at IS NULL
        ORDER BY last_verified_at DESC
        LIMIT 1`
    )
    .get(peerKeyFingerprint) as PeerLinkBindingSqlRow | undefined
  return row ? fromSqlBindingRow(row) : null
}
