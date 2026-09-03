// S10-1 BUG 5: durability for peer mailboxes via mailbox_deliveries, a line-for-line port of
// the Run delivery protocol (db.ts getOrCreateRunDelivery/acknowledgeRunDelivery) with
// `run_id` -> `mailbox_handle` and no `consumer_generation` (a re-minted agent keeps its id
// across a re-mint, so there is nothing to fence — see db.ts's RISKS note on id reuse).
// Kept out of db.ts per the repo's ratchet rule for that file.
import { randomBytes } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import type { MessageRow } from './types'
import type { MailboxDeliveryRow } from './agent-directory-types'
import { filterLiveMessageRows, type LiveMessageFilterOmitted } from './message-visibility-filter'

// Local generator (see agent-directory.ts's note): avoids a require cycle with db.ts.
function generateMailboxDeliveryId(): string {
  return `mdel_${randomBytes(6).toString('hex')}`
}

// Why filtered here too (amendment E, same "Frozen delivery batches" rule as db.ts's
// getDeliveryMessages): message_ids is frozen at mint time, so a purge or quarantine issued
// after the freeze must still drop the row out of every replay — the id itself stays in the
// frozen list so an eventual ack still clears it.
function fetchMessagesByIds(
  db: Database.Database,
  ids: string[]
): { messages: MessageRow[]; omitted: LiveMessageFilterOmitted } {
  if (ids.length === 0) {
    return { messages: [], omitted: { purged: 0, withheld: 0 } }
  }
  const rows = db
    .prepare(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as MessageRow[]
  const byId = new Map(rows.map((row) => [row.id, row]))
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((row): row is MessageRow => row !== undefined)
  return filterLiveMessageRows(db, ordered)
}

export type GetOrCreateMailboxDeliveryParams = {
  mailboxHandle: string
  messageIds: string[]
  limit?: number
}

export type GetOrCreateMailboxDeliveryResult = {
  delivery: MailboxDeliveryRow
  messages: MessageRow[]
  replayed: boolean
  pendingBehind: number
  omitted?: LiveMessageFilterOmitted
}

/**
 * Mints (or replays) the mailbox's one outstanding Delivery. `messageIds` is the caller's
 * current full unread-candidate set (already filtered of legacy/quarantined rows by the RPC
 * layer) — on a fresh mint it is capped at `limit` and frozen; on a replay the frozen ids from
 * the prior mint are returned unchanged and `pendingBehind` is diffed against the *new*
 * `messageIds` the caller just computed, so mail that arrived after the freeze is still
 * counted as stuck-behind without ever joining the outstanding batch (same trap as Run
 * deliveries: message_ids is frozen at creation).
 */
export function getOrCreateMailboxDelivery(
  db: Database.Database,
  params: GetOrCreateMailboxDeliveryParams
): GetOrCreateMailboxDeliveryResult | undefined {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 50)
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = db
      .prepare(
        "SELECT * FROM mailbox_deliveries WHERE mailbox_handle = ? AND status = 'outstanding'"
      )
      .get(params.mailboxHandle) as MailboxDeliveryRow | undefined
    if (existing) {
      const frozenIds = JSON.parse(existing.message_ids) as string[]
      const frozenSet = new Set(frozenIds)
      const pendingBehind = params.messageIds.filter((id) => !frozenSet.has(id)).length
      const { messages, omitted } = fetchMessagesByIds(db, frozenIds)
      // B2 (Ruling 32 Addendum 10/F-17): every frozen id in this replayed Delivery is now
      // permanently unreadable (PURGED — never quarantine-withheld, which is reversible via
      // `--lift` and would destroy recoverable mail if auto-acked, Ruling 32 Addendum 13) —
      // nothing will ever make `messages` non-empty again, so replaying it forever is a
      // permanent head-of-line block on every message queued behind it (F-17's "check prints
      // No messages. forever" symptom). This is NOT a row reclassification (no message row's
      // own state changes beyond the ordinary ack `read=1`) — it clears the STUCK DELIVERY the
      // same way an explicit `--ack` would, and falls through to mint a fresh one from the
      // caller's current candidate set.
      if (messages.length === 0 && frozenIds.length > 0 && omitted.purged === frozenIds.length) {
        const placeholders = frozenIds.map(() => '?').join(',')
        db.prepare(`UPDATE messages SET read = 1 WHERE id IN (${placeholders})`).run(...frozenIds)
        db.prepare(
          "UPDATE mailbox_deliveries SET status = 'acknowledged', acknowledged_at = datetime('now') WHERE id = ?"
        ).run(existing.id)
      } else {
        db.exec('COMMIT')
        return {
          delivery: existing,
          messages,
          replayed: true,
          pendingBehind,
          ...(omitted.purged > 0 || omitted.withheld > 0 ? { omitted } : {})
        }
      }
    }

    const batch = params.messageIds.slice(0, limit)
    if (batch.length === 0) {
      db.exec('COMMIT')
      return undefined
    }
    const deliveryId = generateMailboxDeliveryId()
    db.prepare(
      `INSERT INTO mailbox_deliveries (id, mailbox_handle, message_ids) VALUES (?, ?, ?)`
    ).run(deliveryId, params.mailboxHandle, JSON.stringify(batch))
    const delivery = db
      .prepare('SELECT * FROM mailbox_deliveries WHERE id = ?')
      .get(deliveryId) as MailboxDeliveryRow
    const { messages, omitted } = fetchMessagesByIds(db, batch)
    const pendingBehind = params.messageIds.length - batch.length
    db.exec('COMMIT')
    return {
      delivery,
      messages,
      replayed: false,
      pendingBehind,
      ...(omitted.purged > 0 || omitted.withheld > 0 ? { omitted } : {})
    }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export type AcknowledgeMailboxDeliveryResult = { delivery: MailboxDeliveryRow; duplicate: boolean }

/** Sets `read=1` on exactly the frozen ids of one Delivery. A never-existed id, or one that
 * belongs to a different mailbox, is refused (`stale_delivery`) — ack is scoped to the caller's
 * own mailbox so one agent can never suppress another's outstanding delivery. An
 * already-acknowledged id for THIS mailbox is a no-op (`duplicate: true`) — idempotent ack,
 * never a re-apply. */
export function acknowledgeMailboxDelivery(
  db: Database.Database,
  deliveryId: string,
  mailboxHandle: string
): AcknowledgeMailboxDeliveryResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const delivery = db.prepare('SELECT * FROM mailbox_deliveries WHERE id = ?').get(deliveryId) as
      | MailboxDeliveryRow
      | undefined
    if (!delivery || delivery.mailbox_handle !== mailboxHandle) {
      // Why: let the single catch-block below run the rollback (matches
      // acknowledgeRunDelivery, db.ts:3043-3048) — an inline ROLLBACK here leaves the
      // transaction already closed, so the catch's own ROLLBACK throws
      // ERR_SQLITE_ERROR and masks this typed error entirely.
      throw new OrchestrationError(
        'stale_delivery',
        `Mailbox delivery ${deliveryId} was not found.`,
        { nextSteps: ['orca orchestration check (mint a fresh delivery, then --ack that id)'] }
      )
    }
    if (delivery.status === 'acknowledged') {
      db.exec('COMMIT')
      return { delivery, duplicate: true }
    }
    const ids = JSON.parse(delivery.message_ids) as string[]
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',')
      db.prepare(`UPDATE messages SET read = 1 WHERE id IN (${placeholders})`).run(...ids)
    }
    db.prepare(
      "UPDATE mailbox_deliveries SET status = 'acknowledged', acknowledged_at = datetime('now') WHERE id = ?"
    ).run(deliveryId)
    const acknowledged = db
      .prepare('SELECT * FROM mailbox_deliveries WHERE id = ?')
      .get(deliveryId) as MailboxDeliveryRow
    db.exec('COMMIT')
    return { delivery: acknowledged, duplicate: false }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
