// [S10-21d R107, chair decision] diag-r106-r110-2026-09-08.md: a 'pending' transcript verdict
// (no file yet, or a zero-turn stub) previously entered the same 60s->15min negative backoff as
// a genuine refusal, so a pane whose transcript simply had not been written yet within the first
// minutes of a session could sit "unknown" for up to 15 minutes even though the very next report
// would have found a real turn. The chair's fix (not the two other options considered): a FIXED
// 10s retry for `pending` only (PENDING_TRANSCRIPT_RETRY_MS) — the escalating ladder, the churn
// budget (D-R156 finding 3), and generation-clear (D-R154 finding 1) are all unchanged for a
// genuine negative. No pre-existing test file covered this memoization module (grep confirmed:
// only agent-lineage-mismatch.ts imports it) — created fresh per this brief's "if
// underspecified, report the deviation rather than skipping."
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import {
  checkTranscriptConjunctMemoized,
  resetTranscriptVerdictCacheForTests,
  type LiveReportTranscriptVerdict
} from './agent-lineage-transcript-memo'

const HOST_ID = 'local'
const PANE_KEY = 'tab1:leaf-r107'
const AGENT_TYPE = 'claude'
const LAUNCH_GENERATION = 'gen-1'

describe('R107: a pending transcript verdict gets a fixed 10s retry, not the escalating backoff', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    resetTranscriptVerdictCacheForTests()
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  function rawDb() {
    return (db as unknown as { db: Parameters<typeof checkTranscriptConjunctMemoized>[0] }).db
  }

  function params(reportedSessionId: string) {
    return {
      hostId: HOST_ID,
      paneKey: PANE_KEY,
      reportedSessionId,
      launchGeneration: LAUNCH_GENERATION
    }
  }

  // (a) stub -> pending; a report at +2s does not call the resolver; a report at +12s with a
  // real turn -> positive, elapsed < 60s throughout.
  it('a fork-stub is cached for a fixed 10s: +2s does not re-walk, +12s with a real turn reports positive', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let resolved: LiveReportTranscriptVerdict = { path: '/tmp/stub.jsonl', hasTurn: false }
    const resolve = vi.fn(async () => resolved)

    const first = await checkTranscriptConjunctMemoized(
      rawDb(),
      resolve,
      AGENT_TYPE,
      params('sess-pending')
    )
    expect(first).toEqual({ ok: false, note: undefined })
    expect(resolve).toHaveBeenCalledTimes(1)

    // +2s — inside the fixed 10s retry window: cache hit, no re-walk.
    vi.setSystemTime(2_000)
    const second = await checkTranscriptConjunctMemoized(
      rawDb(),
      resolve,
      AGENT_TYPE,
      params('sess-pending')
    )
    expect(second).toEqual({ ok: false, note: undefined })
    expect(resolve).toHaveBeenCalledTimes(1)

    // +12s — past the 10s window (still well under the old 60s floor) and the transcript now
    // carries a real turn: re-walked, reports positive.
    vi.setSystemTime(12_000)
    resolved = { path: '/tmp/real.jsonl', hasTurn: true }
    const third = await checkTranscriptConjunctMemoized(
      rawDb(),
      resolve,
      AGENT_TYPE,
      params('sess-pending')
    )
    expect(third).toEqual({ ok: true })
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  // (b) a genuinely negative, non-pending verdict ({coverage:'uncovered'} — a foreign/unsupported
  // agent type this resolver does not cover, never "no observation yet") still takes the
  // escalating 60s ladder exactly as before R107.
  it('a genuinely uncovered (non-pending) verdict still takes the 60s escalating ladder', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const resolve = vi.fn(
      async (): Promise<LiveReportTranscriptVerdict> => ({ coverage: 'uncovered' })
    )

    const first = await checkTranscriptConjunctMemoized(
      rawDb(),
      resolve,
      AGENT_TYPE,
      params('sess-uncovered')
    )
    expect(first).toEqual({ ok: false, note: 'resume_preflight_uncovered claude' })
    expect(resolve).toHaveBeenCalledTimes(1)

    // +12s — past the pending-only 10s window, but this is NOT pending: still inside the
    // genuine negative's 60s initial backoff, so no re-walk.
    vi.setSystemTime(12_000)
    const second = await checkTranscriptConjunctMemoized(
      rawDb(),
      resolve,
      AGENT_TYPE,
      params('sess-uncovered')
    )
    expect(second).toEqual({ ok: false, note: 'resume_preflight_uncovered claude' })
    expect(resolve).toHaveBeenCalledTimes(1)

    // +61s — past the 60s initial backoff: re-walks.
    vi.setSystemTime(61_000)
    const third = await checkTranscriptConjunctMemoized(
      rawDb(),
      resolve,
      AGENT_TYPE,
      params('sess-uncovered')
    )
    expect(third).toEqual({ ok: false, note: 'resume_preflight_uncovered claude' })
    expect(resolve).toHaveBeenCalledTimes(2)
  })
})

// [S10-21d D-R162 H-1] A `pending` verdict must not retry at the fixed 10s cadence forever: past
// PENDING_TRANSCRIPT_MAX_CHECKS (12) consecutive pending re-walks (~2 min) it is presumed stuck
// and falls through to the existing 60s->15min ladder as an ordinary negative, seeded fresh (not
// carrying the pending entry's own fixed-retry timestamps forward). A positive verdict or a
// launch-generation change resets the count.
describe('D-R162 H-1: a pending verdict enters the escalating ladder after 12 consecutive checks', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    resetTranscriptVerdictCacheForTests()
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  function rawDb() {
    return (db as unknown as { db: Parameters<typeof checkTranscriptConjunctMemoized>[0] }).db
  }

  function params(reportedSessionId: string, launchGeneration = LAUNCH_GENERATION) {
    return { hostId: HOST_ID, paneKey: PANE_KEY, reportedSessionId, launchGeneration }
  }

  it('stays on the fixed 10s retry for 12 pending re-walks, then takes the ladder at 60s, then 120s', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const resolve = vi.fn(
      async (): Promise<LiveReportTranscriptVerdict> => ({
        path: '/tmp/stub.jsonl',
        hasTurn: false
      })
    )

    // 12 consecutive pending re-walks, each exactly 10s after the previous one's own nextRetryAt.
    for (let i = 1; i <= 12; i++) {
      vi.setSystemTime((i - 1) * 10_000)
      const result = await checkTranscriptConjunctMemoized(
        rawDb(),
        resolve,
        AGENT_TYPE,
        params('sess-stuck')
      )
      expect(result).toEqual({ ok: false, note: undefined })
    }
    expect(resolve).toHaveBeenCalledTimes(12)

    // 13th consecutive pending re-walk, due at +120s (12 * 10s): exhausts the grace, escalates to
    // the ladder's initial 60s backoff instead of another fixed 10s retry.
    vi.setSystemTime(120_000)
    const thirteenth = await checkTranscriptConjunctMemoized(
      rawDb(),
      resolve,
      AGENT_TYPE,
      params('sess-stuck')
    )
    expect(thirteenth).toEqual({ ok: false, note: undefined })
    expect(resolve).toHaveBeenCalledTimes(13)

    // +10s (the old fixed-retry cadence) must NOT re-walk anymore: cache hit off the 60s ladder.
    vi.setSystemTime(130_000)
    await checkTranscriptConjunctMemoized(rawDb(), resolve, AGENT_TYPE, params('sess-stuck'))
    expect(resolve).toHaveBeenCalledTimes(13)

    // +60s from the escalation (t=180_000): re-walks off the ladder's initial backoff, still
    // pending, doubles to 120s — never reseeded back to the fixed 10s retry.
    vi.setSystemTime(180_000)
    await checkTranscriptConjunctMemoized(rawDb(), resolve, AGENT_TYPE, params('sess-stuck'))
    expect(resolve).toHaveBeenCalledTimes(14)

    // +90s (t=270_000) is inside the doubled 120s window: no re-walk yet.
    vi.setSystemTime(270_000)
    await checkTranscriptConjunctMemoized(rawDb(), resolve, AGENT_TYPE, params('sess-stuck'))
    expect(resolve).toHaveBeenCalledTimes(14)

    // +120s from t=180_000 (t=300_000): re-walks again, doubling.
    vi.setSystemTime(300_000)
    await checkTranscriptConjunctMemoized(rawDb(), resolve, AGENT_TYPE, params('sess-stuck'))
    expect(resolve).toHaveBeenCalledTimes(15)
  })

  it('a real turn arriving mid-grace reports positive and resets the pending count', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let resolved: LiveReportTranscriptVerdict = { path: '/tmp/stub.jsonl', hasTurn: false }
    const resolve = vi.fn(async () => resolved)

    for (let i = 1; i <= 5; i++) {
      vi.setSystemTime((i - 1) * 10_000)
      await checkTranscriptConjunctMemoized(rawDb(), resolve, AGENT_TYPE, params('sess-recovers'))
    }
    expect(resolve).toHaveBeenCalledTimes(5)

    vi.setSystemTime(50_000)
    resolved = { path: '/tmp/real.jsonl', hasTurn: true }
    const positive = await checkTranscriptConjunctMemoized(
      rawDb(),
      resolve,
      AGENT_TYPE,
      params('sess-recovers')
    )
    expect(positive).toEqual({ ok: true })
    expect(resolve).toHaveBeenCalledTimes(6)
  })

  it('an absent transcript (resolver reports null) follows the same bounded pending path', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const resolve = vi.fn(async (): Promise<LiveReportTranscriptVerdict> => null)

    for (let i = 1; i <= 12; i++) {
      vi.setSystemTime((i - 1) * 10_000)
      const result = await checkTranscriptConjunctMemoized(
        rawDb(),
        resolve,
        AGENT_TYPE,
        params('sess-absent')
      )
      expect(result).toEqual({ ok: false, note: undefined })
    }
    expect(resolve).toHaveBeenCalledTimes(12)

    // 13th: escalates to the 60s ladder, same as the stub case.
    vi.setSystemTime(120_000)
    await checkTranscriptConjunctMemoized(rawDb(), resolve, AGENT_TYPE, params('sess-absent'))
    expect(resolve).toHaveBeenCalledTimes(13)
    vi.setSystemTime(130_000)
    await checkTranscriptConjunctMemoized(rawDb(), resolve, AGENT_TYPE, params('sess-absent'))
    expect(resolve).toHaveBeenCalledTimes(13)
  })

  it('a launch-generation change resets the pending count back to the fixed 10s retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const resolve = vi.fn(
      async (): Promise<LiveReportTranscriptVerdict> => ({
        path: '/tmp/stub.jsonl',
        hasTurn: false
      })
    )

    for (let i = 1; i <= 12; i++) {
      vi.setSystemTime((i - 1) * 10_000)
      await checkTranscriptConjunctMemoized(
        rawDb(),
        resolve,
        AGENT_TYPE,
        params('sess-gen', 'gen-1')
      )
    }
    expect(resolve).toHaveBeenCalledTimes(12)

    // A new generation clears the cache outright (D-R154 finding 1): the very next check for the
    // same reported id is a fresh pending sighting, fixed 10s retry, not the ladder.
    vi.setSystemTime(120_000)
    await checkTranscriptConjunctMemoized(rawDb(), resolve, AGENT_TYPE, params('sess-gen', 'gen-2'))
    expect(resolve).toHaveBeenCalledTimes(13)

    // +10s under the new generation: still the fixed 10s retry (grace reset), not the ladder.
    vi.setSystemTime(130_000)
    await checkTranscriptConjunctMemoized(rawDb(), resolve, AGENT_TYPE, params('sess-gen', 'gen-2'))
    expect(resolve).toHaveBeenCalledTimes(14)
  })
})
