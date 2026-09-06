import { describe, expect, it, afterEach } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { isHostMessageId } from './orchestration-id-grammar'
import { PACT_RESERVED_HEADROOM, REPLY_OUTBOX_PER_LINK_CAP } from './link-binding-constants'
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

function enqueuePlainMail(sqlite: Database.Database, now: number, suffix: string): string {
  return enqueueReplyOutbox(sqlite, {
    localMessageId: `msg_b4_${suffix}`,
    linkDeviceId: 'link_b4',
    environmentId: 'env_b4',
    boundPairingRevision: 1,
    peerCredentialFp: 'peer_fp_b4',
    peerKeyFingerprint: 'peer_key_fp_b4',
    inReplyToMessageId: `msg_in_reply_b4_${suffix}`,
    peerAgentId: 'agent_b4',
    peerThreadId: null,
    localThreadId: null,
    noticeRunId: null,
    noticePaneKey: null,
    payload: '{}',
    byteCount: 2,
    createdAt: now
  })
}

// S10-21b B4 (design §2.3 step 5, §2.4): enqueueReplyOutbox now stamps four new columns from the
// params plus the pact thread's OWN current pact_state/pact_flight_token, read fresh at insert
// time — never passed in by the caller.
describe('S10-21b B4: enqueueReplyOutbox stamps relay_kind/pact_* columns', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('a plain mail reply (no pact params) stamps relay_kind=reply and every pact_* column NULL — FAILS AT BASE (relay_kind/pact_* were not yet populated by fromSqlRow)', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = (db as unknown as { db: Database.Database }).db
    const now = Date.now()
    const id = enqueuePlainMail(sqlite, now, 'plain')
    const row = getReplyOutboxItem(sqlite, id)
    expect(row?.relayKind).toBe('reply')
    expect(row?.pactThreadId).toBeNull()
    expect(row?.pactSeq).toBeNull()
    expect(row?.pactEra).toBeNull()
    expect(row?.pactTurnAfter).toBeNull()
    expect(row?.pactState).toBeNull()
    expect(row?.pactFlightToken).toBeNull()
  })

  it("a pact item stamps relay_kind/pact_thread_id/pact_seq/pact_era/pact_turn_after from params AND pact_state/pact_flight_token from the thread's CURRENT row, not a caller-supplied value — FAILS AT BASE (no stamping existed)", () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = (db as unknown as { db: Database.Database }).db
    const now = Date.now()
    sqlite
      .prepare(
        `INSERT INTO threads (id, subject, pact_state, pact_flight_token) VALUES (?, 'x', 'engaged', 7)`
      )
      .run('thr_b4_stamp')

    const id = enqueueReplyOutbox(sqlite, {
      localMessageId: 'msg_b4_stamp',
      linkDeviceId: 'link_b4_stamp',
      environmentId: 'env_b4_stamp',
      boundPairingRevision: 1,
      peerCredentialFp: 'peer_fp_b4_stamp',
      peerKeyFingerprint: 'peer_key_fp_b4_stamp',
      inReplyToMessageId: 'msg_in_reply_b4_stamp',
      peerAgentId: 'agent_b4_stamp',
      peerThreadId: null,
      localThreadId: null,
      noticeRunId: null,
      noticePaneKey: null,
      payload: '{}',
      byteCount: 2,
      createdAt: now,
      relayKind: 'pact_step',
      pactThreadId: 'thr_b4_stamp',
      pactSeq: 3,
      pactEra: 0,
      pactTurnAfter: 'agent:b'
    })
    const row = getReplyOutboxItem(sqlite, id)
    expect(row?.relayKind).toBe('pact_step')
    expect(row?.pactThreadId).toBe('thr_b4_stamp')
    expect(row?.pactSeq).toBe(3)
    expect(row?.pactEra).toBe(0)
    expect(row?.pactTurnAfter).toBe('agent:b')
    expect(row?.pactState).toBe('engaged')
    expect(row?.pactFlightToken).toBe(7)

    // Mutate the thread's live state AFTER enqueue — the already-stamped row must NOT reflect
    // it (stamping is at-insert-time only, never a live join).
    sqlite
      .prepare('UPDATE threads SET pact_state = ?, pact_flight_token = ? WHERE id = ?')
      .run('released', 8, 'thr_b4_stamp')
    expect(getReplyOutboxItem(sqlite, id)?.pactState).toBe('engaged')
    expect(getReplyOutboxItem(sqlite, id)?.pactFlightToken).toBe(7)
  })
})

// S10-21b B4 (design §2.11): `reserved` items are admitted up to
// REPLY_OUTBOX_PER_LINK_CAP + PACT_RESERVED_HEADROOM rather than the ordinary per-link cap.
describe('S10-21b B4: reserved-item headroom past REPLY_OUTBOX_PER_LINK_CAP', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('an ordinary (non-reserved) enqueue refuses at REPLY_OUTBOX_PER_LINK_CAP; a reserved one is admitted up to +PACT_RESERVED_HEADROOM and refused past that — FAILS AT BASE (no reserved param existed)', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = (db as unknown as { db: Database.Database }).db
    const now = Date.now()
    const linkDeviceId = 'link_b4_cap'

    const enqueueN = (n: number, reserved: boolean): void => {
      for (let i = 0; i < n; i++) {
        enqueueReplyOutbox(sqlite, {
          localMessageId: `msg_b4_cap_${reserved ? 'r' : 'o'}_${i}`,
          linkDeviceId,
          environmentId: 'env_b4_cap',
          boundPairingRevision: 1,
          peerCredentialFp: 'peer_fp_b4_cap',
          peerKeyFingerprint: 'peer_key_fp_b4_cap',
          inReplyToMessageId: `msg_in_reply_b4_cap_${reserved ? 'r' : 'o'}_${i}`,
          peerAgentId: 'agent_b4_cap',
          peerThreadId: null,
          localThreadId: null,
          noticeRunId: null,
          noticePaneKey: null,
          payload: '{}',
          byteCount: 2,
          createdAt: now,
          reserved,
          relayKind: reserved ? 'pact_release' : undefined
        })
      }
    }

    // Fill to exactly the ordinary cap.
    enqueueN(REPLY_OUTBOX_PER_LINK_CAP, false)
    expect(countPendingReplyOutbox(sqlite, linkDeviceId)).toBe(REPLY_OUTBOX_PER_LINK_CAP)

    // An ordinary (non-reserved) enqueue now refuses.
    expect(() => enqueueN(1, false)).toThrow()

    // A reserved enqueue is admitted, up to PACT_RESERVED_HEADROOM more.
    enqueueN(PACT_RESERVED_HEADROOM, true)
    expect(countPendingReplyOutbox(sqlite, linkDeviceId)).toBe(
      REPLY_OUTBOX_PER_LINK_CAP + PACT_RESERVED_HEADROOM
    )

    // One more reserved enqueue past the combined cap refuses too.
    expect(() => enqueueN(1, true)).toThrow()
  })
})

// S10-21b B4 groundwork (design §0/§8, T17/T23): the `msg_000000000000` sentinel
// (link-binding-constants.ts's HOST_MESSAGE_ID_RE-matching literal used by the injection test
// `orchestration-federation-control-mail.test.ts:612`) and its single confirmed reader
// (isHostMessageId, called from reply-outbox-pump-deliver.ts's settleReplyOutboxDelivery) are
// UNTOUCHED by this commit's schema/column changes — this commit adds relay_kind/pact_* columns
// and the head-of-line clause only; it never reads or writes local_message_id/peer_message_id.
// Full verb-aware sentinel dedupe is commit 8's concern (pact_applied_ids); this is groundwork
// only, pinning that B4 introduced no coupling to the sentinel/reader.
describe('S10-21b B4 groundwork: the msg_000000000000 sentinel and its reader are untouched', () => {
  it('isHostMessageId still matches the sentinel exactly as before this commit (pins pre-existing, unmodified behaviour)', () => {
    expect(isHostMessageId('msg_000000000000')).toBe(true)
  })
})
