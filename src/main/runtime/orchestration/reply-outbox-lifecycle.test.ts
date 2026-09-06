import { describe, expect, it, afterEach } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import {
  enqueueReplyOutbox,
  getReplyOutboxItem,
  cancelQueuedReplyOutbox,
  type RelayKind
} from './reply-outbox-store'
import {
  reclaimExpiredReplyOutboxLeases,
  claimNextReplyOutboxItem,
  settleReplyOutboxItem,
  holdReplyOutboxItem,
  retargetReplyOutboxItem,
  retryReplyOutboxItem
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

function enqueuePactItem(
  sqlite: Database.Database,
  now: number,
  opts: {
    suffix: string
    linkDeviceId: string
    pactThreadId: string
    relayKind: RelayKind
  }
): string {
  return enqueueReplyOutbox(sqlite, {
    localMessageId: `msg_na7_${opts.suffix}`,
    linkDeviceId: opts.linkDeviceId,
    environmentId: 'env_na7',
    boundPairingRevision: 1,
    peerCredentialFp: 'peer_fp_na7',
    peerKeyFingerprint: 'peer_key_fp_na7',
    inReplyToMessageId: `msg_in_reply_na7_${opts.suffix}`,
    peerAgentId: 'agent_na7',
    peerThreadId: null,
    localThreadId: null,
    noticeRunId: null,
    noticePaneKey: null,
    payload: '{}',
    byteCount: 2,
    createdAt: now,
    pactThreadId: opts.pactThreadId,
    pactEra: 0,
    reserved: true,
    relayKind: opts.relayKind
  })
}

// S10-21b B4, T-NA7 (design §2.5, corrected per Addendum 6(15) — the CLOSED bug the unparenthesised
// v3 form had: the exemption disjunct must be OR-ed strictly INSIDE the per-pact NOT EXISTS's own
// parens, never appended unparenthesised to the outer WHERE, or it bypasses every other guard).
// FAILS AT BASE: at base the per-pact clause does not exist at all, so there is no head-of-line
// enforcement to exempt anything FROM — every assertion below is against behaviour this commit
// introduces.
describe('S10-21b B4, T-NA7: the corrected parenthesised per-pact head-of-line exemption', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('an exempt item (pact_release) is claimable behind an unsettled, lower-seq predecessor on the SAME pact; a non-exempt item (pact_step) in the identical position is NOT', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()

    // Predecessor: lower seq (enqueued first), SAME pact, on its OWN route so claiming it can
    // never satisfy/interact with the per-ROUTE guard for the items below — isolates the
    // per-pact clause from the per-route one, which the third test in this suite covers.
    const predecessorId = enqueuePactItem(sqlite, now, {
      suffix: 'predecessor',
      linkDeviceId: 'link_na7_a_pred',
      pactThreadId: 'thr_na7_a',
      relayKind: 'pact_step'
    })
    // Claimed (not settled) — 'sending', settled_at IS NULL — the exact "in flight" shape the
    // per-pact NOT EXISTS keys on: `c.settled_at IS NULL AND c.seq < a.seq`.
    expect(claimNextReplyOutboxItem(sqlite, now)?.id).toBe(predecessorId)

    // Non-exempt item, higher seq, SAME pact, own route — must NOT be claimable: the per-pact
    // NOT EXISTS finds the unsettled predecessor and the OR's right side is false (relay_kind
    // not in the exempt set).
    const nonExemptId = enqueuePactItem(sqlite, now, {
      suffix: 'non-exempt',
      linkDeviceId: 'link_na7_a_nonexempt',
      pactThreadId: 'thr_na7_a',
      relayKind: 'pact_step'
    })
    expect(claimNextReplyOutboxItem(sqlite, now)).toBeNull()
    expect(getReplyOutboxItem(sqlite, nonExemptId)?.state).toBe('queued')

    // Exempt item, higher seq, SAME pact, own route — IS claimable: the OR's right side
    // (`pact_thread_id IS NOT NULL AND relay_kind IN (...)`) is true, so the per-pact NOT
    // EXISTS's false result no longer refuses the row.
    const exemptId = enqueuePactItem(sqlite, now, {
      suffix: 'exempt',
      linkDeviceId: 'link_na7_a_exempt',
      pactThreadId: 'thr_na7_a',
      relayKind: 'pact_release'
    })
    const exemptClaim = claimNextReplyOutboxItem(sqlite, now)
    expect(exemptClaim?.id).toBe(exemptId)
    expect(exemptClaim?.relayKind).toBe('pact_release')

    // The non-exempt item is still untouched throughout.
    expect(getReplyOutboxItem(sqlite, nonExemptId)?.state).toBe('queued')
  })

  it('the SAME exemption does not override "sending", "settled", or backed-off — only the per-pact head-of-line NOT EXISTS is bypassed', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()

    const exemptId = enqueuePactItem(sqlite, now, {
      suffix: 'guard-sending',
      linkDeviceId: 'link_na7_b',
      pactThreadId: 'thr_na7_b',
      relayKind: 'pact_resync'
    })

    // Guard 1: 'sending' — claim it once (state becomes 'sending'), then a second claim call
    // must NOT re-claim it merely because it is exempt.
    const firstClaim = claimNextReplyOutboxItem(sqlite, now)
    expect(firstClaim?.id).toBe(exemptId)
    expect(claimNextReplyOutboxItem(sqlite, now)).toBeNull()

    // Guard 2: settled — settle it, then it must never be claimed again.
    settleReplyOutboxItem(sqlite, exemptId, {
      state: 'delivered',
      settledAt: now,
      consecutiveFailures: 0,
      nextAttemptAfter: null,
      lastErrorCode: null,
      lastError: null
    })
    expect(claimNextReplyOutboxItem(sqlite, now)).toBeNull()

    // Guard 3: backed off — a fresh exempt item with next_attempt_after in the future is not
    // claimable before that time, exemption notwithstanding.
    const backedOffId = enqueuePactItem(sqlite, now, {
      suffix: 'guard-backoff',
      linkDeviceId: 'link_na7_b2',
      pactThreadId: 'thr_na7_b2',
      relayKind: 'pact_gap_notice'
    })
    sqlite
      .prepare('UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ?')
      .run(now + 60_000, backedOffId)
    expect(claimNextReplyOutboxItem(sqlite, now)).toBeNull()
    expect(claimNextReplyOutboxItem(sqlite, now + 60_000)?.id).toBe(backedOffId)
  })

  it('the exemption does NOT bypass the per-ROUTE one-in-flight invariant — an exempt item on a DIFFERENT pact, SAME route, is not claimable while a sibling row on that route is sending', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()

    // Two DIFFERENT pacts sharing the SAME route (link/environment/boundPairingRevision).
    const routeLinkId = 'link_na7_c'
    enqueuePactItem(sqlite, now, {
      suffix: 'route-a',
      linkDeviceId: routeLinkId,
      pactThreadId: 'thr_na7_c1',
      relayKind: 'pact_step'
    })
    const exemptOtherPactId = enqueuePactItem(sqlite, now, {
      suffix: 'route-b-exempt',
      linkDeviceId: routeLinkId,
      pactThreadId: 'thr_na7_c2',
      relayKind: 'pact_release'
    })

    // Claim the first (thr_na7_c1) item — the route is now 'sending'.
    const claimed = claimNextReplyOutboxItem(sqlite, now)
    expect(claimed?.pactThreadId).toBe('thr_na7_c1')

    // The exempt item on the OTHER pact, same route, must NOT be claimable — the per-pact
    // exemption only bypasses the per-PACT NOT EXISTS, never the per-ROUTE one.
    expect(claimNextReplyOutboxItem(sqlite, now)).toBeNull()
    expect(getReplyOutboxItem(sqlite, exemptOtherPactId)?.state).toBe('queued')
  })

  it('a plain mail item (pact_thread_id IS NULL) is entirely unaffected by the new clause — NULL makes the per-pact equality NULL, so it is exempt-by-construction', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()
    const id = enqueueOne(sqlite, now, 'na7-mail')
    expect(getReplyOutboxItem(sqlite, id)?.pactThreadId).toBeNull()
    const claimed = claimNextReplyOutboxItem(sqlite, now)
    expect(claimed?.id).toBe(id)
  })
})

// S10-21b B5 (design §2.8, NA9): retryReplyOutboxItem's first_held_at stamp, scoped to
// relay_kind != 'reply'. FAILS AT BASE: the base retryReplyOutboxItem never touches
// first_held_at at all, so a pact item's first_held_at would stay NULL forever, and the
// PACT_RELAY_HOLD_MAX_MS bound a later commit reads against it would never start.
describe('S10-21b B5, T29 (third assertion): retryReplyOutboxItem first_held_at scoping', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it("a 'reply' item's first_held_at is untouched by a post-dial retry", () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()
    const id = enqueueOne(sqlite, now, 'na9-mail')
    claimNextReplyOutboxItem(sqlite, now)
    expect(getReplyOutboxItem(sqlite, id)?.firstHeldAt).toBeNull()

    const wrote = retryReplyOutboxItem(
      sqlite,
      id,
      now + 5_000,
      now + 10_000,
      1,
      'runtime_timeout',
      'timed out',
      'reply'
    )
    expect(wrote).toBe(true)
    // Mail's clock semantics are unchanged by B5 — first_held_at stays NULL across a retry,
    // exactly as holdReplyOutboxItemLocalEvidence's own test-73 exclusion leaves it.
    expect(getReplyOutboxItem(sqlite, id)?.firstHeldAt).toBeNull()
  })

  it("a pact item's first_held_at is stamped on the first retry and left alone on the second (COALESCE idempotency)", () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()
    const id = enqueuePactItem(sqlite, now, {
      suffix: 'na9-pact',
      linkDeviceId: 'link_na9',
      pactThreadId: 'thr_na9',
      relayKind: 'pact_step'
    })
    claimNextReplyOutboxItem(sqlite, now)
    expect(getReplyOutboxItem(sqlite, id)?.firstHeldAt).toBeNull()

    const firstRetryAt = now + 5_000
    retryReplyOutboxItem(
      sqlite,
      id,
      firstRetryAt,
      firstRetryAt + 10_000,
      0,
      'pact_settling',
      'peer settling',
      'pact_step'
    )
    expect(getReplyOutboxItem(sqlite, id)?.firstHeldAt).toBe(firstRetryAt)

    // Second retry, later `now` — COALESCE leaves the FIRST stamp untouched.
    claimNextReplyOutboxItem(sqlite, firstRetryAt + 10_000)
    const secondRetryAt = now + 60_000
    retryReplyOutboxItem(
      sqlite,
      id,
      secondRetryAt,
      secondRetryAt + 10_000,
      0,
      'pact_settling',
      'peer settling',
      'pact_step'
    )
    expect(getReplyOutboxItem(sqlite, id)?.firstHeldAt).toBe(firstRetryAt)
  })
})
