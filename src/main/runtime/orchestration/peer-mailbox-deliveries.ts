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

// Local generator (see agent-directory.ts's note): avoids a require cycle with db.ts.
function generateMailboxDeliveryId(): string {
  return `mdel_${randomBytes(6).toString('hex')}`
}

function fetchMessagesByIds(db: Database.Database, ids: string[]): MessageRow[] {
  if (ids.length === 0) {
    return []
  }
  const rows = db
    .prepare(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as MessageRow[]
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.map((id) => byId.get(id)).filter((row): row is MessageRow => row !== undefined)
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
      const messages = fetchMessagesByIds(db, frozenIds)
      db.exec('COMMIT')
      return { delivery: existing, messages, replayed: true, pendingBehind }
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
    const messages = fetchMessagesByIds(db, batch)
    const pendingBehind = params.messageIds.length - batch.length
    db.exec('COMMIT')
    return { delivery, messages, replayed: false, pendingBehind }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export type AcknowledgeMailboxDeliveryResult = { delivery: MailboxDeliveryRow; duplicate: boolean }

/** Sets `read=1` on exactly the frozen ids of one Delivery. A never-existed id is refused; an
 * already-acknowledged id is a no-op (`duplicate: true`) — idempotent ack, never a re-apply. */
export function acknowledgeMailboxDelivery(
  db: Database.Database,
  deliveryId: string
): AcknowledgeMailboxDeliveryResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const delivery = db.prepare('SELECT * FROM mailbox_deliveries WHERE id = ?').get(deliveryId) as
      | MailboxDeliveryRow
      | undefined
    if (!delivery) {
      db.exec('ROLLBACK')
      throw new OrchestrationError(
        'stale_delivery',
        `Mailbox delivery ${deliveryId} was not found.`
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
