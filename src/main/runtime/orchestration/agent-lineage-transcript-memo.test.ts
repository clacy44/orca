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
