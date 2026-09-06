// S10-21b B5 (design §2.6(a)/§2.9): classifyReplyRelayError's pact-item branch — the hold/retry/
// terminal classification table, its attempts-derived backoff, and the metered pact-relay audit.
// FAILS AT BASE: the base classifyReplyRelayError takes no relayKind and has no pact branch at
// all, so every relayKind-scoped assertion below either throws (no such export) or falls through
// to the mail-only KNOWN_REFUSAL_CODES/transport-retry paths, producing the wrong `kind`.
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import { classifyReplyRelayError } from './reply-outbox-pump-disposition'
import { enqueueReplyOutbox, type RelayKind } from './reply-outbox-store'
import { claimNextReplyOutboxItem, retryReplyOutboxItem } from './reply-outbox-lifecycle'
import { REPLY_OUTBOX_MAX_MS } from './link-binding-constants'
import { shouldEmitPactRelayAudit, shouldEmitPactDesyncAudit } from './pact-relay-audit-meter'

const PACT_HOLD_CODES = [
  'agent_retired',
  'agent_unknown',
  'derived_agent_unaddressable',
  'agent_quarantined'
]
// S10-21b B11 (design §3.3, SCOPE item 5): `pact_paused` added — a peer refusing an inbound
// apply because ITS OWN copy is paused (e.g. the link-evidence auto-pause, commit 15) is not
// evidence of an unreachable transport, "the same way pact_settling/pact_out_of_order" are not.
// Fails at base: `pact_paused` was unclassified and fell through to the default
// bumpFailure:true branch.
const PACT_RETRY_CODES = [
  'pact_settling',
  'pact_out_of_order',
  'pact_identity_unmirrored',
  'pact_ledger_capped',
  'pact_paused'
]
const PACT_TERMINAL_ONLY_CODES = ['pact_desync', 'pact_era_mismatch', 'pact_no_pact']
// S10-21b B8c (D-R135 finding 10, item 12): seven refusal codes that were in NO classifier set
// at base — falling through to the transport-shaped branch (bumpFailure:true), wrongly bumping
// consecutive_failures toward the link's unreachable threshold for a non-transport pact refusal.
// Pinned as all seven (not six) — see the source comment on PACT_RETRY_CAUSES for why B11's
// `pact_paused` is included here too rather than left to a future rebase.
const PACT_RETRY_CODES_B8C = [
  'pact_paused',
  'pact_exists',
  'pact_no_route',
  'pact_not_engaged',
  'not_a_participant',
  'not_found',
  'pact_repair_not_yet_available'
]

describe('S10-21b B5: classifyReplyRelayError pact-item branch', () => {
  const now = Date.now()

  it.each(PACT_HOLD_CODES)(
    "pact item, code '%s': hold cause classifies as retry, bumpFailure:false (design §2.6(a))",
    (code) => {
      const d = classifyReplyRelayError(
        new OrchestrationError(code, 'peer says so'),
        0,
        now,
        'pact_step',
        3
      )
      expect(d.kind).toBe('retry')
      if (d.kind === 'retry') {
        expect(d.bumpFailure).toBe(false)
        expect(d.disposition).toBe(code)
      }
    }
  )

  it.each(PACT_RETRY_CODES)(
    "pact item, code '%s': retryable pact cause classifies as retry, bumpFailure:false (design §2.9)",
    (code) => {
      const d = classifyReplyRelayError(
        new OrchestrationError(code, 'peer says so'),
        0,
        now,
        'pact_step',
        3
      )
      expect(d.kind).toBe('retry')
      if (d.kind === 'retry') {
        expect(d.bumpFailure).toBe(false)
        expect(d.disposition).toBe(code)
      }
    }
  )

  it.each(PACT_TERMINAL_ONLY_CODES)(
    "pact item, code '%s': terminal cause classifies as refused (design §2.9)",
    (code) => {
      const d = classifyReplyRelayError(
        new OrchestrationError(code, 'peer says so'),
        0,
        now,
        'pact_step'
      )
      expect(d.kind).toBe('refused')
      if (d.kind === 'refused') {
        expect(d.code).toBe(code)
      }
    }
  )

  it.each(PACT_RETRY_CODES_B8C)(
    "pact item, code '%s': non-bumping retry, never the transport-shaped bumpFailure:true fallback (D-R135 finding 10)",
    (code) => {
      const d = classifyReplyRelayError(
        new OrchestrationError(code, 'peer says so'),
        0,
        now,
        'pact_step',
        3
      )
      expect(d.kind).toBe('retry')
      if (d.kind === 'retry') {
        expect(d.bumpFailure).toBe(false)
        expect(d.disposition).toBe(code)
      }
    }
  )

  it("mail item (relayKind defaulted to 'reply'): the same hold-cause codes stay terminal, unchanged from before this commit", () => {
    for (const code of PACT_HOLD_CODES) {
      const d = classifyReplyRelayError(new OrchestrationError(code, 'peer says so'), 0, now)
      expect(d.kind).toBe('refused')
    }
  })

  it('the pact retry/hold backoff is derived from `attempts`, not `consecutiveFailures`, and grows toward REPLY_OUTBOX_MAX_MS', () => {
    const low = classifyReplyRelayError(
      new OrchestrationError('pact_settling', 'x'),
      0,
      now,
      'pact_step',
      1
    )
    const high = classifyReplyRelayError(
      new OrchestrationError('pact_settling', 'x'),
      0,
      now,
      'pact_step',
      20
    )
    expect(low.kind).toBe('retry')
    expect(high.kind).toBe('retry')
    if (low.kind === 'retry' && high.kind === 'retry') {
      expect(high.nextAttemptAfter).toBeGreaterThan(low.nextAttemptAfter)
      // Capped at REPLY_OUTBOX_MAX_MS, ±20% jitter (applyReplyOutboxJitter).
      expect(high.nextAttemptAfter - now).toBeLessThanOrEqual(REPLY_OUTBOX_MAX_MS * 1.2 + 1)
    }
    // consecutiveFailures pinned to a large value must NOT drive the backoff for this bucket —
    // only `attempts` may (design §2.9: "derived from attempts"). Both calls use attempts=1, so
    // both must land in the SAME jittered range around replyOutboxIntervalMs(1) — never in the
    // attempts=99-shaped (capped) range consecutiveFailures alone would produce if it leaked in.
    const consecutiveFailuresIgnored = classifyReplyRelayError(
      new OrchestrationError('pact_settling', 'x'),
      99,
      now,
      'pact_step',
      1
    )
    if (consecutiveFailuresIgnored.kind === 'retry') {
      const interval = consecutiveFailuresIgnored.nextAttemptAfter - now
      // replyOutboxIntervalMs(1) = REPLY_OUTBOX_BASE_MS * 2 = 10_000, ±20% jitter.
      expect(interval).toBeGreaterThanOrEqual(10_000 * 0.8)
      expect(interval).toBeLessThanOrEqual(10_000 * 1.2 + 1)
    }
  })
})

function enqueuePactStep(
  sqlite: Database.Database,
  now: number,
  opts: { linkDeviceId: string; pactThreadId: string; relayKind: RelayKind }
): string {
  return enqueueReplyOutbox(sqlite, {
    localMessageId: `msg_t29_${opts.pactThreadId}`,
    linkDeviceId: opts.linkDeviceId,
    environmentId: 'env_t29',
    boundPairingRevision: 1,
    peerCredentialFp: 'peer_fp_t29',
    peerKeyFingerprint: 'peer_key_fp_t29',
    inReplyToMessageId: `msg_in_reply_t29_${opts.pactThreadId}`,
    peerAgentId: 'agent_t29',
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

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function pactRelayAuditCount(sqlite: Database.Database, code: string): number {
  return (
    sqlite
      .prepare(`SELECT COUNT(*) AS n FROM agent_audit WHERE verb = 'pactRelay' AND outcome = ?`)
      .get(code) as { n: number }
  ).n
}

// T29 (design §8, first assertion): 100 consecutive pact_settling refusals on one (link, pact)
// produce one audit row per 60s window, retry interval grows toward REPLY_OUTBOX_MAX_MS.
describe('S10-21b B5, T29: pact_settling audit suppression + growing backoff', () => {
  let db: OrchestrationDb | undefined

  // D-R133 F7: shouldEmitPactRelayAudit's suppression window keys on real Date.now()
  // (agent-rate-limit.ts's checkAndBumpRate, no injection point) — the 100-iteration loop below
  // was flaky whenever real execution straddled a wall-clock minute boundary mid-loop. Pin the
  // clock just after a window start, frozen for the whole test (never advanced), so the window
  // cannot roll over mid-loop. Never relax the `toBe(1)` assertion instead.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Math.ceil(Date.now() / 60_000) * 60_000 + 100)
  })

  afterEach(() => {
    vi.useRealTimers()
    db?.close()
    db = undefined
  })

  it('100 consecutive pact_settling occurrences on one (link, pact): exactly one pactRelay audit row (real-time 60s window), and the interval grows toward REPLY_OUTBOX_MAX_MS', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const start = Date.now()
    const id = enqueuePactStep(sqlite, start, {
      linkDeviceId: 'link_t29',
      pactThreadId: 'thr_t29',
      relayKind: 'pact_step'
    })

    let simulatedNow = start
    let lastInterval = 0
    for (let i = 0; i < 100; i++) {
      const claimed = claimNextReplyOutboxItem(sqlite, simulatedNow)
      // Reclaim manually if the previous iteration's backoff hasn't "elapsed" in simulated time —
      // this loop drives the state machine directly (pump.ts's own catch-block shape), not
      // through a real timer.
      const item =
        claimed ??
        (() => {
          // Force-advance the simulated clock past the last backoff and reclaim.
          simulatedNow += lastInterval + 1
          return claimNextReplyOutboxItem(sqlite, simulatedNow)
        })()
      expect(item).not.toBeNull()
      const disposition = classifyReplyRelayError(
        new OrchestrationError('pact_settling', 'peer settling'),
        item!.consecutiveFailures,
        simulatedNow,
        item!.relayKind,
        item!.attempts
      )
      expect(disposition.kind).toBe('retry')
      if (disposition.kind !== 'retry') {
        throw new Error('unreachable')
      }
      lastInterval = disposition.nextAttemptAfter - simulatedNow
      retryReplyOutboxItem(
        sqlite,
        id,
        simulatedNow,
        disposition.nextAttemptAfter,
        item!.consecutiveFailures,
        disposition.disposition,
        disposition.errorMessage,
        item!.relayKind
      )
      // Mirrors reply-outbox-pump.ts's own metered-audit call site (real Date.now()-keyed
      // window — every iteration here runs inside the same real 60s window).
      if (shouldEmitPactRelayAudit(db!, 'link_t29', 'thr_t29', disposition.disposition)) {
        db!.writeAgentAudit({
          agentId: null,
          actorPaneKey: null,
          actorHostId: 'link_t29',
          verb: 'pactRelay',
          outcome: disposition.disposition,
          reasonCode: JSON.stringify({ pactThreadId: 'thr_t29' })
        })
      }
    }

    expect(pactRelayAuditCount(sqlite, 'pact_settling')).toBe(1)
    // Growing toward REPLY_OUTBOX_MAX_MS: the last computed interval is far larger than the
    // first attempt's floor (REPLY_OUTBOX_BASE_MS = 5_000) and within the jittered cap.
    expect(lastInterval).toBeGreaterThan(60_000)
    expect(lastInterval).toBeLessThanOrEqual(REPLY_OUTBOX_MAX_MS * 1.2 + 1)
  })
})

// T29 (design §8, pact_desync half): exercised in isolation per the brief — the disposition
// itself (pause + tail-cancel) is commit 9's; this pins ONLY the metering function.
describe('S10-21b B5, T29: pact_desync audit metering in isolation', () => {
  let db: OrchestrationDb | undefined

  // NOTE (chair, after B5b): same real-Date.now() minute-boundary flakiness as the block above
  // — pin the clock just after a window start, frozen for the whole test, per that note.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Math.ceil(Date.now() / 60_000) * 60_000 + 100)
  })

  afterEach(() => {
    vi.useRealTimers()
    db?.close()
    db = undefined
  })

  it('100 consecutive pact_desync-shaped occurrences on one (link, pact): the metering function returns true exactly once per 60s window', () => {
    db = new OrchestrationDb(':memory:')
    let trueCount = 0
    for (let i = 0; i < 100; i++) {
      if (shouldEmitPactDesyncAudit(db, 'link_desync', 'thr_desync')) {
        trueCount++
      }
    }
    expect(trueCount).toBe(1)
  })

  it('is keyed per (link, pact) — a different pact on the same link gets its own window', () => {
    db = new OrchestrationDb(':memory:')
    expect(shouldEmitPactDesyncAudit(db, 'link_desync', 'thr_a')).toBe(true)
    expect(shouldEmitPactDesyncAudit(db, 'link_desync', 'thr_b')).toBe(true)
  })
})
