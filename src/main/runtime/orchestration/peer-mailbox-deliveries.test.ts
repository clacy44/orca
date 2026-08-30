import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb, PEER_RUN_ID } from './db'
import { acknowledgeMailboxDelivery, getOrCreateMailboxDelivery } from './peer-mailbox-deliveries'

describe('peer-mailbox-deliveries (BUG 5)', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function seedMessages(count: number): string[] {
    const db = orchestrationDb as OrchestrationDb
    const ids: string[] = []
    for (let i = 0; i < count; i += 1) {
      const message = db.insertMessage({
        from: 'agent:sender',
        to: 'agent:recipient',
        subject: `msg ${i}`,
        runId: PEER_RUN_ID
      })
      ids.push(message.id)
    }
    return ids
  }

  it('mints a fresh delivery from the given message ids, capped at limit', () => {
    const db = rawDb()
    const ids = seedMessages(3)
    const result = getOrCreateMailboxDelivery(db, {
      mailboxHandle: 'agent:recipient',
      messageIds: ids,
      limit: 2
    })
    expect(result?.replayed).toBe(false)
    expect(result?.messages.map((m) => m.id)).toEqual(ids.slice(0, 2))
    expect(result?.pendingBehind).toBe(1)
  })

  it('D1: kill the client mid-check, re-run without --ack -> identical batch and deliveryId', () => {
    const db = rawDb()
    const ids = seedMessages(2)
    const first = getOrCreateMailboxDelivery(db, {
      mailboxHandle: 'agent:recipient',
      messageIds: ids
    })
    const second = getOrCreateMailboxDelivery(db, {
      mailboxHandle: 'agent:recipient',
      messageIds: ids
    })
    expect(second?.replayed).toBe(true)
    expect(second?.delivery.id).toBe(first?.delivery.id)
    expect(second?.messages.map((m) => m.id)).toEqual(first?.messages.map((m) => m.id))
  })

  it('D2: check -> check --ack -> second check returns empty, pendingBehind:0', () => {
    const db = rawDb()
    const ids = seedMessages(1)
    const minted = getOrCreateMailboxDelivery(db, {
      mailboxHandle: 'agent:recipient',
      messageIds: ids
    })
    expect(minted).toBeDefined()
    acknowledgeMailboxDelivery(db, minted?.delivery.id ?? '')
    const afterAck = getOrCreateMailboxDelivery(db, {
      mailboxHandle: 'agent:recipient',
      messageIds: []
    })
    expect(afterAck).toBeUndefined()
  })

  it('D3: ack on an already-acknowledged (stale) delivery id is a no-op returning duplicate:true', () => {
    const db = rawDb()
    const ids = seedMessages(1)
    const minted = getOrCreateMailboxDelivery(db, {
      mailboxHandle: 'agent:recipient',
      messageIds: ids
    })
    const deliveryId = minted?.delivery.id ?? ''
    const firstAck = acknowledgeMailboxDelivery(db, deliveryId)
    expect(firstAck.duplicate).toBe(false)
    const secondAck = acknowledgeMailboxDelivery(db, deliveryId)
    expect(secondAck.duplicate).toBe(true)
  })

  it('refuses ack on a delivery id that never existed', () => {
    const db = rawDb()
    expect(() => acknowledgeMailboxDelivery(db, 'mdel_does_not_exist')).toThrow()
  })

  it('D4/T4-equivalent: after any number of checks, messages.delivered_at is still NULL', () => {
    const db = rawDb()
    const ids = seedMessages(2)
    getOrCreateMailboxDelivery(db, { mailboxHandle: 'agent:recipient', messageIds: ids })
    getOrCreateMailboxDelivery(db, { mailboxHandle: 'agent:recipient', messageIds: ids })
    getOrCreateMailboxDelivery(db, { mailboxHandle: 'agent:recipient', messageIds: ids })
    const rows = db
      .prepare(`SELECT delivered_at FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { delivered_at: string | null }[]
    expect(rows.every((r) => r.delivered_at === null)).toBe(true)
  })

  it('an outstanding batch is frozen: mail arriving after the freeze counts as pendingBehind, not joined', () => {
    const db = rawDb()
    const firstBatch = seedMessages(1)
    const minted = getOrCreateMailboxDelivery(db, {
      mailboxHandle: 'agent:recipient',
      messageIds: firstBatch
    })
    expect(minted?.replayed).toBe(false)
    const secondBatch = seedMessages(1)
    const allIds = [...firstBatch, ...secondBatch]
    const replay = getOrCreateMailboxDelivery(db, {
      mailboxHandle: 'agent:recipient',
      messageIds: allIds
    })
    expect(replay?.replayed).toBe(true)
    expect(replay?.messages.map((m) => m.id)).toEqual(firstBatch)
    expect(replay?.pendingBehind).toBe(1)
  })

  it('returns undefined when there is nothing to deliver', () => {
    const db = rawDb()
    const result = getOrCreateMailboxDelivery(db, {
      mailboxHandle: 'agent:recipient',
      messageIds: []
    })
    expect(result).toBeUndefined()
  })

  it('acknowledging sets read=1 on exactly the frozen ids, not messages outside the batch', () => {
    const db = rawDb()
    const batch = seedMessages(1)
    const outsideId = seedMessages(1)[0] as string
    const minted = getOrCreateMailboxDelivery(db, {
      mailboxHandle: 'agent:recipient',
      messageIds: batch
    })
    acknowledgeMailboxDelivery(db, minted?.delivery.id ?? '')
    const batchRow = db.prepare('SELECT read FROM messages WHERE id = ?').get(batch[0]) as {
      read: number
    }
    const outsideRow = db.prepare('SELECT read FROM messages WHERE id = ?').get(outsideId) as {
      read: number
    }
    expect(batchRow.read).toBe(1)
    expect(outsideRow.read).toBe(0)
  })

  // Mutation proof: if getOrCreateMailboxDelivery diffed pendingBehind against the FROZEN ids
  // instead of the caller's freshly-computed messageIds, newly arrived mail would never be
  // counted as pending — this is the D5/B2 trap restated for the mailbox-keyed table.
  it('MUTATION PROOF: pendingBehind is computed from the fresh candidate set, not the frozen one', () => {
    const db = rawDb()
    const frozen = seedMessages(1)
    getOrCreateMailboxDelivery(db, { mailboxHandle: 'agent:recipient', messageIds: frozen })
    const fresh = seedMessages(2)
    const allCandidates = [...frozen, ...fresh]
    const replay = getOrCreateMailboxDelivery(db, {
      mailboxHandle: 'agent:recipient',
      messageIds: allCandidates
    })
    expect(replay?.pendingBehind).toBe(2)
  })
})
