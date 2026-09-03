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
    // be resurrected. Ruling 26 Addendum 3(dd)/F4: the write's boolean is returned.
    const heldAfterDelivered = holdReplyOutboxItem(
      sqlite,
      id,
      now,
      now + 1000,
      'held_after_delivered'
    )
    expect(heldAfterDelivered).toBe(false)
    expect(getReplyOutboxItem(sqlite, id)?.state).toBe('delivered')

    const heldSmoke = holdReplyOutboxItem(sqlite, id2, now, now + 1000, 'held_smoke')
    expect(heldSmoke).toBe(true)
    expect(getReplyOutboxItem(sqlite, id2)?.state).toBe('queued')
    expect(getReplyOutboxItem(sqlite, id2)?.holdCount).toBe(1)

    // Ruling 26(a)/(b): a held row is claimable once its clock passes (B1) — retarget itself is
    // guarded state='sending' -> 'queued', same P18/R14.3 shape as holdReplyOutboxItem, so it
    // runs against a freshly re-claimed row, exactly as holdOrRetargetReplyOutboxItem calls it.
    const reclaimed2 = claimNextReplyOutboxItem(sqlite, now + 1000)
    expect(reclaimed2?.id).toBe(id2)
    const retargeted = retargetReplyOutboxItem(sqlite, id2, {
      linkDeviceId: 'link_smoke_5_retargeted',
      environmentId: 'env_smoke_5_retargeted',
      boundPairingRevision: 2,
      peerCredentialFp: 'peer_fp_5_retargeted',
      peerKeyFingerprint: 'peer_key_fp_5_retargeted'
    })
    expect(retargeted).toBe(true)
    expect(getReplyOutboxItem(sqlite, id2)?.linkDeviceId).toBe('link_smoke_5_retargeted')
    // Ruling 26(b): the release resets hold_count/first_held_at/next_attempt_after and the row
    // lands back in 'queued' — a retarget never re-holds.
    expect(getReplyOutboxItem(sqlite, id2)?.state).toBe('queued')
    expect(getReplyOutboxItem(sqlite, id2)?.holdCount).toBe(0)
    expect(getReplyOutboxItem(sqlite, id2)?.firstHeldAt).toBeNull()
    expect(getReplyOutboxItem(sqlite, id2)?.nextAttemptAfter).toBeNull()

    // M1 regression check for the guard formula itself: claim -> resetMessages (cancel) -> hold
    // does NOT resurrect the cancelled row.
    const id3 = enqueueOne(sqlite, now, 'c')
    claimNextReplyOutboxItem(sqlite, now)
    cancelQueuedReplyOutbox(sqlite, now)
    expect(getReplyOutboxItem(sqlite, id3)?.state).toBe('cancelled')
    const heldAfterCancel = holdReplyOutboxItem(sqlite, id3, now, now + 1000, 'held_after_cancel')
    expect(heldAfterCancel).toBe(false)
    expect(getReplyOutboxItem(sqlite, id3)?.state).toBe('cancelled')
  })
})

// Design v6 catalogue scenario 71 (P18): the claim/settle lease.
describe('scenario 71 (P18): the claim/settle lease', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('settleReplyOutboxItem is guarded state=sending — a resetMessages cancel mid-flight makes the settle update zero rows and the item stays cancelled', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()
    const id = enqueueOne(sqlite, now, 'settle-cancel')
    const claimed = claimNextReplyOutboxItem(sqlite, now)
    expect(claimed?.state).toBe('sending')
    cancelQueuedReplyOutbox(sqlite, now)
    expect(getReplyOutboxItem(sqlite, id)?.state).toBe('cancelled')
    const settled = settleReplyOutboxItem(sqlite, id, {
      state: 'delivered',
      settledAt: now,
      consecutiveFailures: 0,
      nextAttemptAfter: null,
      lastErrorCode: null,
      lastError: null
    })
    // Zero rows updated — the caller (reply-outbox-pump.ts) reads this boolean and audits
    // `settled_after_cancel` instead of silently resurrecting a cancelled item.
    expect(settled).toBe(false)
    expect(getReplyOutboxItem(sqlite, id)?.state).toBe('cancelled')
  })

  it('R18.7/v6 protocol M4: a sending item survives a restart untouched until its lease expires, then reclaims to queued and is claimable again — WITHOUT the reclaim it would stay sending forever', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()
    const id = enqueueOne(sqlite, now, 'restart')
    claimNextReplyOutboxItem(sqlite, now)
    const leaseExpiresAt = getReplyOutboxItem(sqlite, id)?.leaseExpiresAt
    expect(leaseExpiresAt).not.toBeNull()

    // "Restart" is simulated the way R18.7 actually observes it: a fresh reclaim call against
    // the SAME persisted db, nothing else touched. Before the lease has expired, reclaim is a
    // no-op and — this is the negative property that proves the defect scenario 71 names is
    // real — the row is NOT claimable (claimNextReplyOutboxItem requires state='queued'), so
    // without a reclaim mechanism this row would sit 'sending' indefinitely.
    expect(reclaimExpiredReplyOutboxLeases(sqlite, leaseExpiresAt! - 1)).toBe(0)
    expect(getReplyOutboxItem(sqlite, id)?.state).toBe('sending')
    expect(claimNextReplyOutboxItem(sqlite, leaseExpiresAt! - 1)).toBeNull()

    // v6 protocol M4: this is "the first statement of every pump tick" — no restart is actually
    // required, only the lease's own expiry; the mid-process reclaim (no crash, no restart) is
    // the same call with the same effect.
    expect(reclaimExpiredReplyOutboxLeases(sqlite, leaseExpiresAt! + 1)).toBe(1)
    const reclaimedRow = getReplyOutboxItem(sqlite, id)
    expect(reclaimedRow?.state).toBe('queued')
    expect(reclaimedRow?.leaseExpiresAt).toBeNull()
    const reclaimedClaim = claimNextReplyOutboxItem(sqlite, leaseExpiresAt! + 1)
    expect(reclaimedClaim?.id).toBe(id)
  })
})

// Ruling 28 Addendum 1(q)/D2/D-3: `settled_at IS NULL` in both the claim's SELECT and its
// UPDATE — a `repair_rejected` row (state left 'queued', settled_at stamped, next_attempt_after
// NULL — the v40 repair's fallback shape, `peer-link-binding-migration.test.ts`) sits ahead of
// real work in `seq` order and must never be claimed.
describe('Ruling 28 Addendum 1(q): the claim skips a settled (repair_rejected) row', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('a repair_rejected row ahead of real work in seq order is skipped and the real row is claimed', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()

    // The v40 repair fallback's own shape (db.ts's repair for a pre-review row, which allowed a
    // NULL payload/link_device_id — not representable against this fresh db's own NOT NULL
    // schema, so the row here uses dummy non-null values): state left 'queued',
    // settled_at stamped, next_attempt_after NULL — inserted directly (never through
    // enqueueReplyOutbox) at seq 1, strictly ahead of the real row enqueued below.
    sqlite
      .prepare(
        `INSERT INTO peer_reply_outbox (
           id, seq, local_message_id, link_device_id, environment_id, bound_pairing_revision,
           peer_credential_fp, peer_key_fingerprint, in_reply_to_message_id, peer_agent_id,
           payload, byte_count, state, settled_at, last_error_code, created_at
         ) VALUES (?, 1, 'msg_repair_rejected_claim', 'link_rr_claim', 'env_rr_claim', 1, 'pfp',
                   'pkf', 'orig_rr_claim', 'agent_rr_claim', '{}', 0, 'queued', ?,
                   'repair_rejected', ?)`
      )
      .run('outbox_repair_rejected_claim', now, now)

    const realId = enqueueOne(sqlite, now, 'claim-skips-repair-rejected')

    const claimed = claimNextReplyOutboxItem(sqlite, now)
    expect(claimed?.id).toBe(realId)
    expect(claimed?.state).toBe('sending')

    // The repair_rejected row is left completely alone — never claimed, ever.
    const zombie = sqlite
      .prepare('SELECT state, settled_at FROM peer_reply_outbox WHERE id = ?')
      .get('outbox_repair_rejected_claim') as { state: string; settled_at: number | null }
    expect(zombie.state).toBe('queued')
    expect(zombie.settled_at).not.toBeNull()

    // No further candidate — a second claim call finds nothing else to do.
    expect(claimNextReplyOutboxItem(sqlite, now)).toBeNull()
  })
})
