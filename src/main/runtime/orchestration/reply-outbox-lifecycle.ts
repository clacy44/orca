// S10-16 R14.6/R18.1: the durable state-transition statements for peer_reply_outbox — reclaim,
// claim, settle, hold, retarget. Split from reply-outbox-store.ts (types/enqueue/reads) to stay
// under max-lines (plan §7.6).
import type Database from '../../sqlite/sync-database'
import { REPLY_OUTBOX_RPC_BUDGET_MS, REPLY_OUTBOX_LEASE_GRACE_MS } from './link-binding-constants'
import { type ReplyOutboxRow, getReplyOutboxItem } from './reply-outbox-store'

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

// R18.1/P18: the durable claim. Selects the oldest eligible item across every route (seq order,
// hold_count = 0, due), then claims it with a guarded state transition — zero rows updated means
// another claimant (or a reset) won the race, so the caller should try the next candidate.
export function claimNextReplyOutboxItem(
  db: Database.Database,
  now: number
): ReplyOutboxRow | null {
  const candidates = db
    .prepare(
      `SELECT id FROM peer_reply_outbox
        WHERE state = 'queued' AND hold_count = 0
          AND (next_attempt_after IS NULL OR next_attempt_after <= ?)
        ORDER BY seq ASC`
    )
    .all(now) as { id: string }[]
  const leaseExpiresAt = now + REPLY_OUTBOX_RPC_BUDGET_MS * 2 + REPLY_OUTBOX_LEASE_GRACE_MS
  for (const candidate of candidates) {
    const result = db
      .prepare(
        `UPDATE peer_reply_outbox
            SET state = 'sending', lease_expires_at = ?, attempts = attempts + 1, last_attempt_at = ?
          WHERE id = ? AND state = 'queued'`
      )
      .run(leaseExpiresAt, now, candidate.id)
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
      WHERE id = ?`
  ).run(now, nextAttemptAfter, lastErrorCode, id)
}

// R18.4(b): rewrite the route onto a freshly re-bound link, keyed by the retarget peer key.
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
): void {
  db.prepare(
    `UPDATE peer_reply_outbox
        SET link_device_id = ?, environment_id = ?, bound_pairing_revision = ?,
            peer_credential_fp = ?, peer_key_fingerprint = ?
      WHERE id = ?`
  ).run(
    route.linkDeviceId,
    route.environmentId,
    route.boundPairingRevision,
    route.peerCredentialFp,
    route.peerKeyFingerprint,
    id
  )
}
