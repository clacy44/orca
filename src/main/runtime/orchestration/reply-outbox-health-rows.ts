// S10-16 C6a, Ruling 27(b): the check-path outbox accessor, split from reply-outbox-store.ts to
// stay under max-lines (that file was already at its budget). The ONLY columns the health mapper
// reads (never `payload`), filtered to the states that matter (queued, sending, an abandoned row
// still inside its LINK_BINDING_REVERIFY_MS attention window), LIMIT'd to the per-link register
// cap. Replaces `listReplyOutbox`'s unfiltered `SELECT *` on the hottest read in the fleet
// (s10-16-review-C6.md F2).
import type Database from '../../sqlite/sync-database'
import { LINK_BINDING_REVERIFY_MS, REPLY_OUTBOX_PER_LINK_CAP } from './link-binding-constants'
import type { ReplyOutboxRow, ReplyOutboxState } from './reply-outbox-store'

export type ReplyOutboxHealthRow = Pick<
  ReplyOutboxRow,
  'state' | 'consecutiveFailures' | 'lastErrorCode' | 'createdAt' | 'settledAt'
>

export function listReplyOutboxHealthRows(
  db: Database.Database,
  linkDeviceId: string,
  now: number
): ReplyOutboxHealthRow[] {
  // Ruling 27 Addendum 1(i): the SQL predicate anchors the terminal (abandoned) window on
  // settled_at, falling back to created_at when settled_at is NULL — COALESCE mirrors the TS
  // mapper's `row.settledAt ?? row.createdAt` in reply-outbox-health.ts exactly.
  const rows = db
    .prepare(
      `SELECT state, consecutive_failures, last_error_code, created_at, settled_at
         FROM peer_reply_outbox
        WHERE link_device_id = ?
          AND (state IN ('queued', 'sending')
               OR (state = 'abandoned' AND COALESCE(settled_at, created_at) > ?))
        ORDER BY seq ASC LIMIT ?`
    )
    .all(linkDeviceId, now - LINK_BINDING_REVERIFY_MS, REPLY_OUTBOX_PER_LINK_CAP) as {
    state: ReplyOutboxState
    consecutive_failures: number
    last_error_code: string | null
    created_at: number
    settled_at: number | null
  }[]
  return rows.map((r) => ({
    state: r.state,
    consecutiveFailures: r.consecutive_failures,
    lastErrorCode: r.last_error_code,
    createdAt: r.created_at,
    settledAt: r.settled_at
  }))
}
