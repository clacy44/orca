// S10-16 R14.6: SQL for peer_reply_outbox — the durable reply relay's rows, types, enqueue and
// read accessors. Split from the transition/lifecycle statements (claim/settle/hold/retarget,
// reply-outbox-lifecycle.ts) to stay under max-lines (plan §7.6).
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import {
  REPLY_OUTBOX_BASE_MS,
  REPLY_OUTBOX_MAX_MS,
  REPLY_OUTBOX_PER_LINK_CAP,
  REPLY_OUTBOX_JITTER_RATIO,
  CANCELLED_LOCAL_RESET_CODE
} from './link-binding-constants'
import { LinkBindingCapError } from './link-binding-store'

export type ReplyOutboxState =
  | 'queued'
  | 'sending'
  | 'delivered'
  | 'refused'
  | 'abandoned'
  | 'cancelled'

export type ReplyOutboxRow = {
  id: string
  seq: number
  localMessageId: string
  linkDeviceId: string
  environmentId: string
  boundPairingRevision: number
  peerCredentialFp: string
  peerKeyFingerprint: string
  inReplyToMessageId: string
  peerAgentId: string
  peerThreadId: string | null
  localThreadId: string | null
  noticeRunId: string | null
  noticePaneKey: string | null
  payload: string
  byteCount: number
  state: ReplyOutboxState
  leaseExpiresAt: number | null
  attempts: number
  consecutiveFailures: number
  holdCount: number
  firstHeldAt: number | null
  lastAttemptAt: number | null
  nextAttemptAfter: number | null
  lastErrorCode: string | null
  lastError: string | null
  peerMessageId: string | null
  peerReplyThreadId: string | null
  createdAt: number
  settledAt: number | null
  notifiedAt: number | null
}

type ReplyOutboxSqlRow = {
  id: string
  seq: number
  local_message_id: string
  link_device_id: string
  environment_id: string
  bound_pairing_revision: number
  peer_credential_fp: string
  peer_key_fingerprint: string
  in_reply_to_message_id: string
  peer_agent_id: string
  peer_thread_id: string | null
  local_thread_id: string | null
  notice_run_id: string | null
  notice_pane_key: string | null
  payload: string
  byte_count: number
  state: ReplyOutboxState
  lease_expires_at: number | null
  attempts: number
  consecutive_failures: number
  hold_count: number
  first_held_at: number | null
  last_attempt_at: number | null
  next_attempt_after: number | null
  last_error_code: string | null
  last_error: string | null
  peer_message_id: string | null
  peer_reply_thread_id: string | null
  created_at: number
  settled_at: number | null
  notified_at: number | null
}

function fromSqlRow(row: ReplyOutboxSqlRow): ReplyOutboxRow {
  return {
    id: row.id,
    seq: row.seq,
    localMessageId: row.local_message_id,
    linkDeviceId: row.link_device_id,
    environmentId: row.environment_id,
    boundPairingRevision: row.bound_pairing_revision,
    peerCredentialFp: row.peer_credential_fp,
    peerKeyFingerprint: row.peer_key_fingerprint,
    inReplyToMessageId: row.in_reply_to_message_id,
    peerAgentId: row.peer_agent_id,
    peerThreadId: row.peer_thread_id,
    localThreadId: row.local_thread_id,
    noticeRunId: row.notice_run_id,
    noticePaneKey: row.notice_pane_key,
    payload: row.payload,
    byteCount: row.byte_count,
    state: row.state,
    leaseExpiresAt: row.lease_expires_at,
    attempts: row.attempts,
    consecutiveFailures: row.consecutive_failures,
    holdCount: row.hold_count,
    firstHeldAt: row.first_held_at,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAfter: row.next_attempt_after,
    lastErrorCode: row.last_error_code,
    lastError: row.last_error,
    peerMessageId: row.peer_message_id,
    peerReplyThreadId: row.peer_reply_thread_id,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    notifiedAt: row.notified_at
  }
}

export type EnqueueReplyOutboxParams = {
  localMessageId: string
  linkDeviceId: string
  environmentId: string
  boundPairingRevision: number
  peerCredentialFp: string
  peerKeyFingerprint: string
  inReplyToMessageId: string
  peerAgentId: string
  peerThreadId: string | null
  localThreadId: string | null
  noticeRunId: string | null
  noticePaneKey: string | null
  payload: string
  byteCount: number
  createdAt: number
}

// R16 / R14.5: refuses `link_binding_conflict` past REPLY_OUTBOX_PER_LINK_CAP, never evicts.
export function enqueueReplyOutbox(db: Database.Database, p: EnqueueReplyOutboxParams): string {
  const pending = countPendingReplyOutbox(db, p.linkDeviceId)
  if (pending >= REPLY_OUTBOX_PER_LINK_CAP) {
    throw new LinkBindingCapError('peer_reply_outbox')
  }
  const id = randomUUID()
  const nextSeq = db
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM peer_reply_outbox')
    .get() as {
    seq: number
  }
  db.prepare(
    `INSERT INTO peer_reply_outbox (
       id, seq, local_message_id, link_device_id, environment_id, bound_pairing_revision,
       peer_credential_fp, peer_key_fingerprint, in_reply_to_message_id, peer_agent_id,
       peer_thread_id, local_thread_id, notice_run_id, notice_pane_key, payload, byte_count,
       state, attempts, consecutive_failures, hold_count, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, 0, ?)`
  ).run(
    id,
    nextSeq.seq,
    p.localMessageId,
    p.linkDeviceId,
    p.environmentId,
    p.boundPairingRevision,
    p.peerCredentialFp,
    p.peerKeyFingerprint,
    p.inReplyToMessageId,
    p.peerAgentId,
    p.peerThreadId,
    p.localThreadId,
    p.noticeRunId,
    p.noticePaneKey,
    p.payload,
    p.byteCount,
    p.createdAt
  )
  return id
}

export function getReplyOutboxItem(db: Database.Database, id: string): ReplyOutboxRow | null {
  const row = db.prepare('SELECT * FROM peer_reply_outbox WHERE id = ?').get(id) as
    | ReplyOutboxSqlRow
    | undefined
  return row ? fromSqlRow(row) : null
}

// R19.2/PART 0.7: `sent --id` keys its relay-branch lookup on the SENDER's own local reply row —
// `local_message_id` is UNIQUE (R14 DDL) so this is a lookup, not a second branch.
export function getReplyOutboxItemByLocalMessageId(
  db: Database.Database,
  localMessageId: string
): ReplyOutboxRow | null {
  const row = db
    .prepare('SELECT * FROM peer_reply_outbox WHERE local_message_id = ?')
    .get(localMessageId) as ReplyOutboxSqlRow | undefined
  return row ? fromSqlRow(row) : null
}

export function listReplyOutbox(db: Database.Database, linkDeviceId?: string): ReplyOutboxRow[] {
  const rows = (
    linkDeviceId === undefined
      ? db.prepare('SELECT * FROM peer_reply_outbox ORDER BY seq ASC').all()
      : db
          .prepare('SELECT * FROM peer_reply_outbox WHERE link_device_id = ? ORDER BY seq ASC')
          .all(linkDeviceId)
  ) as ReplyOutboxSqlRow[]
  return rows.map(fromSqlRow)
}

export function countPendingReplyOutbox(db: Database.Database, linkDeviceId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM peer_reply_outbox
        WHERE link_device_id = ? AND state IN ('queued', 'sending')`
    )
    .get(linkDeviceId) as { n: number }
  return row.n
}

// R14.3: resetMessages's cancel — every queued AND sending row (P18), BEFORE `DELETE FROM messages`.
export function cancelQueuedReplyOutbox(db: Database.Database, now: number): number {
  const result = db
    .prepare(
      `UPDATE peer_reply_outbox
          SET state = 'cancelled', last_error_code = ?, settled_at = ?,
              next_attempt_after = NULL, lease_expires_at = NULL
        WHERE state IN ('queued', 'sending')`
    )
    .run(CANCELLED_LOCAL_RESET_CODE, now)
  return Number(result.changes)
}

// R19.3/P2: the per-item half of the authorship-unconfirmed notice's edge trigger — set once,
// never cleared (an item settles once; a fresh advisory needs a fresh item).
export function markReplyOutboxNotified(db: Database.Database, id: string, now: number): void {
  db.prepare('UPDATE peer_reply_outbox SET notified_at = ? WHERE id = ?').run(now, id)
}

// R18.7/pump idle scheduling: the earliest a queued item becomes claimable — a NULL
// `next_attempt_after` is immediately claimable (claimNextReplyOutboxItem's own WHERE clause
// treats NULL that way), so it wins the MIN unconditionally; null return means nothing is queued
// at all (an empty outbox, or one whose every row is held with a future clock, is instead caught
// by that row's own next_attempt_after value, never by this returning null).
export function nextReplyOutboxWakeAt(db: Database.Database): number | null {
  const row = db
    .prepare(
      `SELECT MIN(COALESCE(next_attempt_after, 0)) AS t FROM peer_reply_outbox WHERE state = 'queued'`
    )
    .get() as { t: number | null }
  return row.t
}

// A-arith(8): the outbox backoff curve, deterministic core (jitter is applied by the pump/C5 at
// scheduling time, never here — this value is also what the kick clamps to, and the clamp must be
// exact for test 63/78's "no nearer than the item's own current interval" assertion).
export function replyOutboxIntervalMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return REPLY_OUTBOX_BASE_MS
  }
  return Math.min(REPLY_OUTBOX_BASE_MS * 2 ** consecutiveFailures, REPLY_OUTBOX_MAX_MS)
}

// M8 (C5 review)/R18.2/Ruling 26(i): ±REPLY_OUTBOX_JITTER_RATIO jitter, applied at the two
// scheduling sites that compute a backoff FOR THE NEXT ATTEMPT (the claim's pre-dial backoff and
// the disposition table's retry schedule) — never at the kick clamp, which test 63/78 requires to
// land EXACTLY on `replyOutboxIntervalMs(n)` ("no nearer than the item's own current interval").
export function applyReplyOutboxJitter(intervalMs: number): number {
  const span = intervalMs * REPLY_OUTBOX_JITTER_RATIO
  const jitter = (Math.random() * 2 - 1) * span
  return Math.max(0, Math.round(intervalMs + jitter))
}

// Chair briefing §0 decision 2 (Ruling 23(b)): the ITEM's own current interval — never the global
// REPLY_OUTBOX_BASE_MS — which is what closes P-5 (a talkative peer pinning a dead route's retry
// at 5s) without breaking test 78's asymmetric-reachability curve.
export function replyOutboxKickFloorAt(row: { consecutiveFailures: number }, now: number): number {
  return now + replyOutboxIntervalMs(row.consecutiveFailures)
}

// P-5 + P-6 + L-B1 (Ruling 23(b)): the kick, one statement per eligible row. `holdCount = 0` (P-6)
// so a held row is untouched; `nextAttemptAfter IS NOT NULL` so a fresh row is never delayed by a
// kick (P-5 third order); the clamp NEVER touches consecutive_failures (R18.2's single-reset-site
// sentence stands).
export function kickReplyOutboxForLink(
  db: Database.Database,
  linkDeviceId: string,
  now: number
): void {
  const rows = db
    .prepare(
      `SELECT id, consecutive_failures FROM peer_reply_outbox
        WHERE link_device_id = ? AND state = 'queued' AND hold_count = 0
          AND next_attempt_after IS NOT NULL`
    )
    .all(linkDeviceId) as { id: string; consecutive_failures: number }[]
  const update = db.prepare(
    `UPDATE peer_reply_outbox SET next_attempt_after = MIN(next_attempt_after, ?) WHERE id = ?`
  )
  for (const row of rows) {
    update.run(
      replyOutboxKickFloorAt({ consecutiveFailures: row.consecutive_failures }, now),
      row.id
    )
  }
}
