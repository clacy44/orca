// S10-16 R14.6/R18.1: the durable state-transition statements for peer_reply_outbox — reclaim,
// claim, settle, hold, retarget. Split from reply-outbox-store.ts (types/enqueue/reads) to stay
// under max-lines (plan §7.6).
import type Database from '../../sqlite/sync-database'
import {
  REPLY_OUTBOX_RPC_BUDGET_MS,
  REPLY_OUTBOX_LEASE_GRACE_MS,
  REPLY_RELAY_COLLISION_CODE
} from './link-binding-constants'
import {
  type ReplyOutboxRow,
  getReplyOutboxItem,
  replyOutboxIntervalMs,
  applyReplyOutboxJitter
} from './reply-outbox-store'

// R18.7, and (v6, protocol M4) the first statement of every pump tick: a 'sending' row whose
// lease expired (a crash mid-RPC) reverts to 'queued' so it is claimable again.
export function reclaimExpiredReplyOutboxLeases(db: Database.Database, now: number): number {
  const result = db
    .prepare(
      `UPDATE peer_reply_outbox
          SET state = 'queued', lease_expires_at = NULL
        WHERE state = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`
    )
    .run(now)
  return Number(result.changes)
}

// R18.1/P18: the durable claim. Selects the oldest eligible item, PER ROUTE — the
// (link_device_id, environment_id, bound_pairing_revision) triple design v6:3196-3212 names —
// skipping any candidate whose route already has a row `sending` (R18.1: "holds no more than one
// in flight per route"), then claims it with a guarded state transition; zero rows updated means
// another claimant (or a reset) won the race, so the caller tries the next candidate. Signature
// is unchanged (db, now) — no route parameter — so C5 needs no signature change: the "per route"
// guarantee is enforced by the NOT EXISTS clause, not by the caller choosing a route.
//
// C4 carry-forward D2: the SELECT's NOT EXISTS is a read-time check only — between the SELECT and
// this row's own UPDATE, a second process (a separate OS process holding the same DB file, SQLite
// serialises but does not order across connections) can claim a sibling row on the same route,
// which would let two processes each believe they alone are 'sending' for that route. The same
// NOT EXISTS clause is therefore repeated in the UPDATE's own WHERE, correlated on the row being
// updated, so the claim itself is atomic: it can succeed only if no sibling is 'sending' AT UPDATE
// TIME, not merely at SELECT time.
export function claimNextReplyOutboxItem(
  db: Database.Database,
  now: number
): ReplyOutboxRow | null {
  // Ruling 26(a)/B1: a hold is expressed by next_attempt_after (+ first_held_at for the
  // abandonment clock) and by NOTHING else. hold_count is a reporting counter only — it never
  // gates the claim (dropped `AND hold_count = 0`, which made every hold terminal: nothing ever
  // resets that column, so the row became permanently unclaimable the first time it was held).
  // A held row whose next_attempt_after has passed is claimed like any other row, and R18.3's
  // abandon deadline (checked at the head of processItem, on every claim) then delivers,
  // refuses, or abandons it — never strands it.
  const candidates = db
    .prepare(
      `SELECT id, consecutive_failures AS consecutiveFailures FROM peer_reply_outbox a
        WHERE state = 'queued'
          AND (next_attempt_after IS NULL OR next_attempt_after <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM peer_reply_outbox b
             WHERE b.link_device_id = a.link_device_id
               AND b.environment_id = a.environment_id
               AND b.bound_pairing_revision = a.bound_pairing_revision
               AND b.state = 'sending'
          )
        ORDER BY seq ASC`
    )
    .all(now) as { id: string; consecutiveFailures: number }[]
  const leaseExpiresAt = now + REPLY_OUTBOX_RPC_BUDGET_MS * 2 + REPLY_OUTBOX_LEASE_GRACE_MS
  for (const candidate of candidates) {
    // R18.2: next_attempt_after is advanced BEFORE the socket opens (same UPDATE as the claim),
    // so a crash-loop mid-attempt cannot hot-loop on restart — the reclaimed row (R18.7) lands
    // 'queued' with this backoff already in place rather than immediately due again. Computed
    // from the item's own current consecutive_failures (unchanged by this claim — that column's
    // single writer is still the settle) via the same deterministic curve the kick uses.
    const preDialBackoff =
      now + applyReplyOutboxJitter(replyOutboxIntervalMs(candidate.consecutiveFailures))
    const result = db
      .prepare(
        `UPDATE peer_reply_outbox AS a
            SET state = 'sending', lease_expires_at = ?, attempts = attempts + 1,
                last_attempt_at = ?, next_attempt_after = ?
          WHERE id = ? AND state = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM peer_reply_outbox b
               WHERE b.link_device_id = a.link_device_id
                 AND b.environment_id = a.environment_id
                 AND b.bound_pairing_revision = a.bound_pairing_revision
                 AND b.state = 'sending'
            )`
      )
      .run(leaseExpiresAt, now, preDialBackoff, candidate.id)
    if (result.changes === 1) {
      return getReplyOutboxItem(db, candidate.id)
    }
  }
  return null
}

export type ReplyOutboxSettle = {
  state: 'delivered' | 'refused' | 'abandoned'
  settledAt: number
  consecutiveFailures: number
  nextAttemptAfter: number | null
  lastErrorCode: string | null
  lastError: string | null
  peerMessageId?: string | null
  peerReplyThreadId?: string | null
}

// Guarded `state='sending' -> <terminal>` (R18.1). Zero rows updated after a reset means the item
// was cancelled underneath the in-flight call; the caller writes the audit row and moves on.
export function settleReplyOutboxItem(
  db: Database.Database,
  id: string,
  s: ReplyOutboxSettle
): boolean {
  const result = db
    .prepare(
      `UPDATE peer_reply_outbox
          SET state = ?, settled_at = ?, lease_expires_at = NULL,
              consecutive_failures = ?, next_attempt_after = ?,
              last_error_code = ?, last_error = ?,
              peer_message_id = COALESCE(?, peer_message_id),
              peer_reply_thread_id = COALESCE(?, peer_reply_thread_id)
        WHERE id = ? AND state = 'sending'`
    )
    .run(
      s.state,
      s.settledAt,
      s.consecutiveFailures,
      s.nextAttemptAfter,
      s.lastErrorCode,
      s.lastError,
      s.peerMessageId ?? null,
      s.peerReplyThreadId ?? null,
      id
    )
  return result.changes === 1
}

// R18.4(a): a bounded, scheduled hold — back to 'queued' with the hold clock and next re-attempt.
// Guarded `state='sending' -> 'queued'`, same as settleReplyOutboxItem (P18/R14.3): a cancellation
// that landed in between (resetMessages) wins — zero rows updated means the item is no longer
// 'sending' and the hold must not resurrect it.
export function holdReplyOutboxItem(
  db: Database.Database,
  id: string,
  now: number,
  nextAttemptAfter: number,
  lastErrorCode: string
): void {
  db.prepare(
    `UPDATE peer_reply_outbox
        SET state = 'queued', lease_expires_at = NULL, hold_count = hold_count + 1,
            first_held_at = COALESCE(first_held_at, ?), next_attempt_after = ?, last_error_code = ?
      WHERE id = ? AND state = 'sending'`
  ).run(now, nextAttemptAfter, lastErrorCode, id)
}

// R18.5: a transport-shaped outcome (an RPC was actually attempted and failed) retries — back to
// 'queued' with the backoff curve advanced and `consecutive_failures` bumped. Distinct from
// holdReplyOutboxItem (a PRE-DIAL check that never touches consecutive_failures) and from
// settleReplyOutboxItem (a terminal state). Guarded `state='sending' -> 'queued'` (P18/R14.3).
export function retryReplyOutboxItem(
  db: Database.Database,
  id: string,
  nextAttemptAfter: number,
  consecutiveFailures: number,
  lastErrorCode: string | null,
  lastError: string | null
): boolean {
  const result = db
    .prepare(
      `UPDATE peer_reply_outbox
          SET state = 'queued', lease_expires_at = NULL, consecutive_failures = ?,
              next_attempt_after = ?, last_error_code = ?, last_error = ?
        WHERE id = ? AND state = 'sending'`
    )
    .run(consecutiveFailures, nextAttemptAfter, lastErrorCode, lastError, id)
  return result.changes === 1
}

// R18.4(a)/L4: the local-evidence hold — deliberately NOT holdReplyOutboxItem. `first_held_at`
// is left exactly as it was (never COALESCEd to `now`), so REPLY_OUTBOX_HOLD_MAX_MS's clock
// never starts while this host cannot read its own registry/environment store (test 73). Guarded
// `state='sending' -> 'queued'` for the same P18/R14.3 reason as holdReplyOutboxItem.
export function holdReplyOutboxItemLocalEvidence(
  db: Database.Database,
  id: string,
  nextAttemptAfter: number
): void {
  db.prepare(
    `UPDATE peer_reply_outbox
        SET state = 'queued', lease_expires_at = NULL, hold_count = hold_count + 1,
            next_attempt_after = ?, last_error_code = 'local_evidence_unavailable'
      WHERE id = ? AND state = 'sending'`
  ).run(nextAttemptAfter, id)
}

// R18.4(b)/Ruling 26(b): rewrite the route onto a freshly re-bound link AND release the row in
// ONE statement — hold_count, first_held_at and next_attempt_after reset, guarded
// `state='sending' -> 'queued'` (same P18/R14.3 cancellation-race reason as holdReplyOutboxItem).
// A retarget never re-holds: this is the row's ONLY write for a successful retarget (B1/B2 —
// the caller must not follow this with a hold call).
export function retargetReplyOutboxItem(
  db: Database.Database,
  id: string,
  route: {
    linkDeviceId: string
    environmentId: string
    boundPairingRevision: number
    peerCredentialFp: string
    peerKeyFingerprint: string
  }
): boolean {
  const result = db
    .prepare(
      `UPDATE peer_reply_outbox
          SET link_device_id = ?, environment_id = ?, bound_pairing_revision = ?,
              peer_credential_fp = ?, peer_key_fingerprint = ?,
              state = 'queued', lease_expires_at = NULL,
              hold_count = 0, first_held_at = NULL, next_attempt_after = NULL,
              last_error_code = NULL
        WHERE id = ? AND state = 'sending'`
    )
    .run(
      route.linkDeviceId,
      route.environmentId,
      route.boundPairingRevision,
      route.peerCredentialFp,
      route.peerKeyFingerprint,
      id
    )
  return result.changes === 1
}

// M10 (C5 review)/Ruling 26(j): the in-flight-registry collision hold — deliberately NOT
// holdReplyOutboxItem. Mirrors holdReplyOutboxItemLocalEvidence's shape (first_held_at left
// exactly as it was, never COALESCEd — this is this host's own scheduling, not a remote outage,
// and must never start the R18.3 abandon clock) but carries the collision's own register code
// rather than local_evidence_unavailable's.
export function holdReplyOutboxItemCollision(
  db: Database.Database,
  id: string,
  nextAttemptAfter: number
): void {
  db.prepare(
    `UPDATE peer_reply_outbox
        SET state = 'queued', lease_expires_at = NULL, hold_count = hold_count + 1,
            next_attempt_after = ?, last_error_code = ?
      WHERE id = ? AND state = 'sending'`
  ).run(nextAttemptAfter, REPLY_RELAY_COLLISION_CODE, id)
}
