import { describe, expect, it, afterEach } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import {
  enqueueReplyOutbox,
  getReplyOutboxItem,
  cancelQueuedReplyOutbox
} from './reply-outbox-store'
import {
  reclaimExpiredReplyOutboxLeases,
  claimNextReplyOutboxItem,
  settleReplyOutboxItem,
  holdReplyOutboxItem,
  retargetReplyOutboxItem
} from './reply-outbox-lifecycle'

// F15/SMOKE: one test per store module that calls EVERY exported statement once against a fresh
// v40 DB — this is the test that would have caught F1 (a prepared statement whose column names
// are only validated when it runs).

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function enqueueOne(sqlite: Database.Database, now: number, suffix: string): string {
  return enqueueReplyOutbox(sqlite, {
    localMessageId: `msg_smoke_5_${suffix}`,
    linkDeviceId: 'link_smoke_5',
    environmentId: 'env_smoke_5',
    boundPairingRevision: 1,
    peerCredentialFp: 'peer_fp_5',
    peerKeyFingerprint: 'peer_key_fp_5',
    inReplyToMessageId: `msg_in_reply_5_${suffix}`,
    peerAgentId: 'agent_smoke_5',
    peerThreadId: null,
    localThreadId: null,
    noticeRunId: null,
    noticePaneKey: null,
    payload: '{}',
    byteCount: 2,
    createdAt: now
  })
}

describe('reply-outbox-lifecycle: smoke (every exported statement runs against a fresh v40 DB)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('calls every exported statement once', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()

    expect(reclaimExpiredReplyOutboxLeases(sqlite, now)).toBe(0)

    const id = enqueueOne(sqlite, now, 'a')
    const claimed = claimNextReplyOutboxItem(sqlite, now)
    expect(claimed?.id).toBe(id)
    expect(claimed?.state).toBe('sending')
    // M3: pre-dial backoff is written in the same UPDATE as the claim.
    expect(getReplyOutboxItem(sqlite, id)?.nextAttemptAfter).not.toBeNull()

    // M3: per-route — a second item on the SAME route is not claimable while the first is
    // 'sending'.
    const id2 = enqueueOne(sqlite, now, 'b')
    expect(claimNextReplyOutboxItem(sqlite, now)).toBeNull()

    const settled = settleReplyOutboxItem(sqlite, id, {
      state: 'delivered',
      settledAt: now,
      consecutiveFailures: 0,
      nextAttemptAfter: null,
      lastErrorCode: null,
      lastError: null
    })
    expect(settled).toBe(true)
    expect(getReplyOutboxItem(sqlite, id)?.state).toBe('delivered')

    // Now the second item's route is free.
    const claimed2 = claimNextReplyOutboxItem(sqlite, now)
    expect(claimed2?.id).toBe(id2)

    // M1: holdReplyOutboxItem is guarded on state='sending' — a settled/cancelled row must not
    // be resurrected.
    holdReplyOutboxItem(sqlite, id, now, now + 1000, 'held_after_delivered')
    expect(getReplyOutboxItem(sqlite, id)?.state).toBe('delivered')

    holdReplyOutboxItem(sqlite, id2, now, now + 1000, 'held_smoke')
    expect(getReplyOutboxItem(sqlite, id2)?.state).toBe('queued')
    expect(getReplyOutboxItem(sqlite, id2)?.holdCount).toBe(1)

    retargetReplyOutboxItem(sqlite, id2, {
      linkDeviceId: 'link_smoke_5_retargeted',
      environmentId: 'env_smoke_5_retargeted',
      boundPairingRevision: 2,
      peerCredentialFp: 'peer_fp_5_retargeted',
      peerKeyFingerprint: 'peer_key_fp_5_retargeted'
    })
    expect(getReplyOutboxItem(sqlite, id2)?.linkDeviceId).toBe('link_smoke_5_retargeted')

    // M1 regression check for the guard formula itself: claim -> resetMessages (cancel) -> hold
    // does NOT resurrect the cancelled row.
    const id3 = enqueueOne(sqlite, now, 'c')
    claimNextReplyOutboxItem(sqlite, now)
    cancelQueuedReplyOutbox(sqlite, now)
    expect(getReplyOutboxItem(sqlite, id3)?.state).toBe('cancelled')
    holdReplyOutboxItem(sqlite, id3, now, now + 1000, 'held_after_cancel')
    expect(getReplyOutboxItem(sqlite, id3)?.state).toBe('cancelled')
  })
})
