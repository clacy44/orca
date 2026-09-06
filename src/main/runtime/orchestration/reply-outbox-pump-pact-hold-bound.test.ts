// S10-21b B9b (design v3.1:560-570/684-700, §2.6(c), gap 21b-G1): the 24h PACT_RELAY_HOLD_MAX_MS
// bound gets a consumer on both entry points — POST-DIAL (reply-outbox-pump.ts's retry branch,
// via firePactHoldExpiredDisposition) and PRE-DIAL (reply-outbox-pump-hold.ts's
// holdOrRetargetReplyOutboxItem). FAILS AT BASE: base exports no firePactHoldExpiredDisposition
// (a pact retry always retries, however long held — F1-F3 of the brief), and
// holdOrRetargetReplyOutboxItem bounds every row, pact included, at REPLY_OUTBOX_HOLD_MAX_MS
// (15 min), never raising it for a pact row (F2).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from './orchestration-error'
import { createThread } from './thread-directory'
import { enqueueReplyOutbox, type RelayKind } from './reply-outbox-store'
import { claimNextReplyOutboxItem, retryReplyOutboxItem } from './reply-outbox-lifecycle'
import { classifyReplyRelayError } from './reply-outbox-pump-disposition'
import {
  firePactHoldExpiredDisposition,
  fireReplyOutboxAgeAbandon
} from './pact-federated-terminal-settle'
import { holdOrRetargetReplyOutboxItem } from './reply-outbox-pump-hold'
import type * as LinkBindingRoutable from './link-binding-routable'
import {
  REPLY_OUTBOX_HOLD_MAX_MS,
  PACT_RELAY_HOLD_MAX_MS,
  REPLY_OUTBOX_MAX_AGE_MS
} from './link-binding-constants'

// PRE-DIAL tests only: bypasses the real registry/environment-store reads
// (readEnvironmentSnapshot) that localEvidenceUnavailable would otherwise take — no candidate is
// ever seeded (db.findBindingCandidateByKeyFingerprint finds nothing), so the retarget branch is
// never reached regardless; only localEvidenceUnavailable needs a deterministic false.
vi.mock('./link-binding-routable', async (importOriginal) => {
  const actual = await importOriginal<typeof LinkBindingRoutable>()
  return { ...actual, localEvidenceUnavailable: vi.fn(() => false) }
})

function raw(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function enqueueItem(
  sqlite: Database.Database,
  id: string,
  opts: { relayKind: RelayKind; pactThreadId: string | null; createdAt: number }
): string {
  return enqueueReplyOutbox(sqlite, {
    localMessageId: `msg_${id}`,
    linkDeviceId: `link_${id}`,
    environmentId: `env_${id}`,
    boundPairingRevision: 1,
    peerCredentialFp: `peer_fp_${id}`,
    peerKeyFingerprint: `peer_key_fp_${id}`,
    inReplyToMessageId: `msg_in_reply_${id}`,
    peerAgentId: `agent_${id}`,
    peerThreadId: null,
    localThreadId: null,
    noticeRunId: null,
    noticePaneKey: null,
    payload: '{}',
    byteCount: 2,
    createdAt: opts.createdAt,
    ...(opts.pactThreadId !== null
      ? { pactThreadId: opts.pactThreadId, pactEra: 0, reserved: true }
      : {}),
    relayKind: opts.relayKind
  })
}

describe('S10-21b B9b, PRE-DIAL: holdOrRetargetReplyOutboxItem bounds a pact row at PACT_RELAY_HOLD_MAX_MS, mail unchanged', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  })

  afterEach(() => {
    db.close()
  })

  it('RED AT BASE (base bounds every row at 15 min): a pact row held 15 min + 1 s is NOT abandoned/route_moved', () => {
    const sqlite = raw(db)
    const start = 1_000_000_000_000
    const id = enqueueItem(sqlite, 'pact_predial_a', {
      relayKind: 'pact_step',
      pactThreadId: 'thr_predial_a',
      createdAt: start
    })
    const claimed = claimNextReplyOutboxItem(sqlite, start)
    expect(claimed?.id).toBe(id)
    const now = start + REPLY_OUTBOX_HOLD_MAX_MS + 1000 // 15 min + 1 s
    holdOrRetargetReplyOutboxItem(runtime, { ...claimed!, firstHeldAt: start }, now)
    const after = db.getReplyOutboxItem(id)
    expect(after?.state).toBe('queued')
  })

  it("GREEN AFTER FIX, also green at base (24h exceeds base's 15 min bound too): a pact row held 24h + 1 s IS abandoned/route_moved", () => {
    const sqlite = raw(db)
    const start = 1_000_000_000_000
    const id = enqueueItem(sqlite, 'pact_predial_b', {
      relayKind: 'pact_step',
      pactThreadId: 'thr_predial_b',
      createdAt: start
    })
    const claimed = claimNextReplyOutboxItem(sqlite, start)
    expect(claimed?.id).toBe(id)
    const now = start + PACT_RELAY_HOLD_MAX_MS + 1000 // 24 h + 1 s
    holdOrRetargetReplyOutboxItem(runtime, { ...claimed!, firstHeldAt: start }, now)
    const after = db.getReplyOutboxItem(id)
    expect(after?.state).toBe('refused')
    expect(after?.lastErrorCode).toBe('route_moved')
  })

  it('GREEN AT BASE (regression guard — mail is untouched): a mail row held 15 min + 1 s still abandons', () => {
    const sqlite = raw(db)
    const start = 1_000_000_000_000
    const id = enqueueItem(sqlite, 'mail_predial_c', {
      relayKind: 'reply',
      pactThreadId: null,
      createdAt: start
    })
    const claimed = claimNextReplyOutboxItem(sqlite, start)
    expect(claimed?.id).toBe(id)
    const now = start + REPLY_OUTBOX_HOLD_MAX_MS + 1000 // 15 min + 1 s
    holdOrRetargetReplyOutboxItem(runtime, { ...claimed!, firstHeldAt: start }, now)
    const after = db.getReplyOutboxItem(id)
    expect(after?.state).toBe('refused')
    expect(after?.lastErrorCode).toBe('route_moved')
  })
})

describe('S10-21b B9b, POST-DIAL: a held pact row takes the §2.6(c) terminal disposition at PACT_RELAY_HOLD_MAX_MS, measured from first_held_at only', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let threadId: string

  beforeEach(() => {
    vi.useFakeTimers()
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const { thread } = createThread(raw(db), {
      subject: 'B9b post-dial seed',
      createdByAgentId: null,
      origin: 'peer',
      participants: []
    })
    threadId = thread.id
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  function seedHeldItem(start: number): string {
    const sqlite = raw(db)
    const id = enqueueItem(sqlite, 'pact_postdial', {
      relayKind: 'pact_step',
      pactThreadId: threadId,
      createdAt: start
    })
    const claimed = claimNextReplyOutboxItem(sqlite, start)
    if (!claimed) {
      throw new Error('unreachable: claim failed')
    }
    // First occurrence: classify + retryReplyOutboxItem, exactly as reply-outbox-pump.ts's catch
    // block does — this is what stamps first_held_at = COALESCE(first_held_at, now) (B5).
    const disposition = classifyReplyRelayError(
      new OrchestrationError('agent_retired', 'peer retired'),
      claimed.consecutiveFailures,
      start,
      claimed.relayKind,
      claimed.attempts
    )
    if (disposition.kind !== 'retry') {
      throw new Error('unreachable: expected retry')
    }
    retryReplyOutboxItem(
      sqlite,
      id,
      start,
      disposition.nextAttemptAfter,
      claimed.consecutiveFailures,
      disposition.disposition,
      disposition.errorMessage,
      claimed.relayKind
    )
    return id
  }

  it('GREEN AT BASE (base also always retries): 15 min + 1 s after first_held_at, still retried, not terminal', () => {
    const start = 2_000_000_000_000
    const id = seedHeldItem(start)
    const sqlite = raw(db)
    // Reclaim (next_attempt_after was set in the past relative to the check point below).
    sqlite
      .prepare('UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ?')
      .run(start, id)
    const now = start + 15 * 60 * 1000 + 1000
    const item = claimNextReplyOutboxItem(sqlite, now)
    expect(item?.id).toBe(id)
    expect(item?.firstHeldAt).toBe(start)
    const fired = firePactHoldExpiredDisposition(runtime, db, item!, 'agent_retired', now)
    expect(fired).toBe(false)
    expect(db.getReplyOutboxItem(id)?.state).toBe('sending')
  })

  it('GREEN AT BASE (still within the 24h bound, base also retries): 23h 59m after first_held_at, still retried', () => {
    const start = 2_000_000_000_000
    const id = seedHeldItem(start)
    const sqlite = raw(db)
    sqlite
      .prepare('UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ?')
      .run(start, id)
    const now = start + 23 * 60 * 60 * 1000 + 59 * 60 * 1000
    const item = claimNextReplyOutboxItem(sqlite, now)
    expect(item?.id).toBe(id)
    const fired = firePactHoldExpiredDisposition(runtime, db, item!, 'agent_retired', now)
    expect(fired).toBe(false)
    expect(db.getReplyOutboxItem(id)?.state).toBe('sending')
  })

  it("RED AT BASE (base retries forever; no consumer of PACT_RELAY_HOLD_MAX_MS exists): 24h + 1s after first_held_at, B9's terminal disposition fires exactly once", () => {
    const start = 2_000_000_000_000
    const id = seedHeldItem(start)
    const sqlite = raw(db)
    sqlite
      .prepare('UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ?')
      .run(start, id)
    const now = start + PACT_RELAY_HOLD_MAX_MS + 1000
    const item = claimNextReplyOutboxItem(sqlite, now)
    expect(item?.id).toBe(id)
    const fired = firePactHoldExpiredDisposition(runtime, db, item!, 'agent_retired', now)
    expect(fired).toBe(true)
    const settled = db.getReplyOutboxItem(id)
    expect(settled?.state).toBe('refused')
    expect(settled?.lastErrorCode).toBe('agent_retired')
    expect(settled?.lastError).toBe('pact_hold_expired')
    const threadRow = sqlite
      .prepare(
        `SELECT pact_paused_at, pact_relay_pending, pact_turn_in_flight_at FROM threads WHERE id = ?`
      )
      .get(threadId) as {
      pact_paused_at: string | null
      pact_relay_pending: string | null
      pact_turn_in_flight_at: string | null
    }
    // §2.6(c) steps 2-5: tail cancelled (nothing else queued here to cancel, but the pause and
    // gap_notice queue are the observable proof the SAME machinery B9 built actually fired).
    expect(threadRow.pact_paused_at).not.toBeNull()
    expect(threadRow.pact_relay_pending).toBe('gap_notice')
    expect(threadRow.pact_turn_in_flight_at).toBeNull()
    // Fires exactly once: a second call at the same instant is a no-op (item no longer 'sending').
    const secondFired = firePactHoldExpiredDisposition(runtime, db, item!, 'agent_retired', now)
    expect(secondFired).toBe(true) // isPactHoldExpired is still true (relayKind/disposition/firstHeldAt unchanged)
    expect(db.getReplyOutboxItem(id)?.state).toBe('refused') // but the settle itself raced, not double-applied
  })
})

// B9c (D-R134 F10): the pump's own 7-day age-abandon (reply-outbox-pump.ts) must route a pact
// row through §2.6(c)'s terminal settle, never the mail-shaped plain abandon. FAILS AT BASE:
// fireReplyOutboxAgeAbandon does not exist — base's age-abandon is the plain
// settleReplyOutboxItem({state:'abandoned'}) path for every relay kind, pact included, so no
// tail-cancel/pause/gap_notice ever fires on a pact row that ages out this way.
describe('S10-21b B9c: fireReplyOutboxAgeAbandon routes a pact row through §2.6(c), mail unchanged', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let threadId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const { thread } = createThread(raw(db), {
      subject: 'B9c age-abandon seed',
      createdByAgentId: null,
      origin: 'peer',
      participants: []
    })
    threadId = thread.id
  })

  afterEach(() => {
    db.close()
  })

  it('RED AT BASE: a pact row past REPLY_OUTBOX_MAX_AGE_MS takes the §2.6(c) terminal disposition, not the plain abandon', () => {
    const sqlite = raw(db)
    const start = 3_000_000_000_000
    const id = enqueueItem(sqlite, 'pact_age_abandon', {
      relayKind: 'pact_step',
      pactThreadId: threadId,
      createdAt: start
    })
    const claimed = claimNextReplyOutboxItem(sqlite, start)
    expect(claimed?.id).toBe(id)
    const now = start + REPLY_OUTBOX_MAX_AGE_MS + 1000
    fireReplyOutboxAgeAbandon(runtime, db, claimed!, now)
    const settled = db.getReplyOutboxItem(id)
    expect(settled?.state).toBe('refused') // §2.6(c)'s terminal settle, never 'abandoned'
    expect(settled?.lastErrorCode).toBe('pact_relay_abandoned')
    const threadRow = sqlite
      .prepare(
        `SELECT pact_paused_at, pact_relay_pending, pact_turn_in_flight_at FROM threads WHERE id = ?`
      )
      .get(threadId) as {
      pact_paused_at: string | null
      pact_relay_pending: string | null
      pact_turn_in_flight_at: string | null
    }
    expect(threadRow.pact_paused_at).not.toBeNull()
    expect(threadRow.pact_relay_pending).toBe('gap_notice')
    expect(threadRow.pact_turn_in_flight_at).toBeNull()
  })

  it('GREEN AT BASE (regression guard): a mail row still takes the plain abandon, unaffected by B9c', () => {
    const sqlite = raw(db)
    const start = 3_000_000_000_000
    const id = enqueueItem(sqlite, 'mail_age_abandon', {
      relayKind: 'reply',
      pactThreadId: null,
      createdAt: start
    })
    const claimed = claimNextReplyOutboxItem(sqlite, start)
    expect(claimed?.id).toBe(id)
    const now = start + REPLY_OUTBOX_MAX_AGE_MS + 1000
    fireReplyOutboxAgeAbandon(runtime, db, claimed!, now)
    const settled = db.getReplyOutboxItem(id)
    expect(settled?.state).toBe('abandoned') // the mail-shaped settle, unchanged by B9c
    expect(settled?.lastErrorCode).toBeNull()
  })
})
