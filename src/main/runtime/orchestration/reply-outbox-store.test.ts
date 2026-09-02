import { describe, expect, it, afterEach } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import {
  enqueueReplyOutbox,
  getReplyOutboxItem,
  listReplyOutbox,
  countPendingReplyOutbox,
  cancelQueuedReplyOutbox,
  replyOutboxIntervalMs,
  replyOutboxKickFloorAt,
  kickReplyOutboxForLink
} from './reply-outbox-store'

// F15/SMOKE: one test per store module that calls EVERY exported statement once against a fresh
// v40 DB — this is the test that would have caught F1 (a prepared statement whose column names
// are only validated when it runs).

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('reply-outbox-store: smoke (every exported statement runs against a fresh v40 DB)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('calls every exported statement once', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()
    const linkDeviceId = 'link_smoke_4'

    expect(countPendingReplyOutbox(sqlite, linkDeviceId)).toBe(0)

    const id = enqueueReplyOutbox(sqlite, {
      localMessageId: 'msg_smoke_4',
      linkDeviceId,
      environmentId: 'env_smoke_4',
      boundPairingRevision: 1,
      peerCredentialFp: 'peer_fp_4',
      peerKeyFingerprint: 'peer_key_fp_4',
      inReplyToMessageId: 'msg_in_reply_4',
      peerAgentId: 'agent_smoke_4',
      peerThreadId: null,
      localThreadId: null,
      noticeRunId: null,
      noticePaneKey: null,
      payload: '{}',
      byteCount: 2,
      createdAt: now
    })

    expect(getReplyOutboxItem(sqlite, id)).not.toBeNull()
    expect(listReplyOutbox(sqlite)).toHaveLength(1)
    expect(listReplyOutbox(sqlite, linkDeviceId)).toHaveLength(1)
    expect(countPendingReplyOutbox(sqlite, linkDeviceId)).toBe(1)

    expect(replyOutboxIntervalMs(0)).toBeGreaterThan(0)
    expect(replyOutboxIntervalMs(3)).toBeGreaterThan(replyOutboxIntervalMs(0))
    expect(replyOutboxKickFloorAt({ consecutiveFailures: 0 }, now)).toBeGreaterThan(now)

    // kickReplyOutboxForLink only touches rows with next_attempt_after already set — set one
    // first so the statement has a row to act on.
    sqlite
      .prepare('UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ?')
      .run(now + 1_000_000, id)
    kickReplyOutboxForLink(sqlite, linkDeviceId, now)
    expect(getReplyOutboxItem(sqlite, id)?.nextAttemptAfter).toBeLessThanOrEqual(now + 1_000_000)

    const cancelled = cancelQueuedReplyOutbox(sqlite, now)
    expect(cancelled).toBe(1)
    expect(getReplyOutboxItem(sqlite, id)?.state).toBe('cancelled')
    expect(countPendingReplyOutbox(sqlite, linkDeviceId)).toBe(0)
  })
})
