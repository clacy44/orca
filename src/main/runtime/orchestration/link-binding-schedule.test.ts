import { describe, expect, it } from 'vitest'
import {
  linkBindingIntervalMs,
  deriveRoundEpoch,
  roundBudgetMs,
  selectRoundPage,
  RoundTokenBucket,
  LinkBindingRerunFlag,
  RoundEpochCounter,
  RearmDebounce,
  scheduleBindingPatch,
  createInFlightGuard,
  type PageCandidateLink
} from './link-binding-schedule'
import {
  LINK_BINDING_BACKOFF_BASE_MS,
  LINK_BINDING_BACKOFF_MAX_MS,
  LINK_BINDING_MAX_ROUNDS_PER_MIN,
  LINK_BINDING_MIN_KICK_INTERVAL_MS,
  LINK_BINDING_PROBE_SLOTS,
  LINK_BINDING_INFLIGHT_GRACE_MS
} from './link-binding-constants'

describe('linkBindingIntervalMs (R13.2)', () => {
  it('grows as base * 2^n, capped at BACKOFF_MAX_MS, with the jitter bound to +/-20%', () => {
    const zeroRandom = () => 0
    const oneRandom = () => 1 - Number.EPSILON
    for (let n = 0; n < 3; n += 1) {
      const base = LINK_BINDING_BACKOFF_BASE_MS * 2 ** n
      const low = linkBindingIntervalMs(n, zeroRandom)
      const high = linkBindingIntervalMs(n, oneRandom)
      expect(low).toBeGreaterThanOrEqual(Math.round(base * 0.8) - 1)
      expect(high).toBeLessThanOrEqual(Math.round(base * 1.2) + 1)
    }
  })

  it('never exceeds LINK_BINDING_BACKOFF_MAX_MS even at high n', () => {
    const high = linkBindingIntervalMs(20, () => 1 - Number.EPSILON)
    expect(high).toBeLessThanOrEqual(Math.round(LINK_BINDING_BACKOFF_MAX_MS * 1.2) + 1)
  })

  it('never goes negative', () => {
    expect(linkBindingIntervalMs(0, () => 0)).toBeGreaterThanOrEqual(0)
  })
})

describe('deriveRoundEpoch (R10.5)', () => {
  it('is strictly greater than both now and the prior max', () => {
    expect(deriveRoundEpoch(null, 1000)).toBe(1001)
    expect(deriveRoundEpoch(500, 1000)).toBe(1001)
    expect(deriveRoundEpoch(2000, 1000)).toBe(2001)
  })

  it('survives a clock step-back: the epoch still increases past the prior max', () => {
    const first = deriveRoundEpoch(null, 5000)
    const steppedBack = deriveRoundEpoch(first, 1000)
    expect(steppedBack).toBeGreaterThan(first)
  })
})

describe('RoundEpochCounter (Ruling 23 Addendum 6(ww)/review C4d finding 11)', () => {
  it('is strictly increasing across two calls at the SAME millisecond, unlike deriveRoundEpoch alone', () => {
    // The exact bug: two rounds started at the same `now`, both deriving from the same
    // MAX(last_round_at), give the SAME epoch via deriveRoundEpoch alone.
    expect(deriveRoundEpoch(1000, 1000)).toBe(deriveRoundEpoch(1000, 1000))

    const counter = new RoundEpochCounter()
    const first = counter.next(1000, 1000)
    const second = counter.next(1000, 1000)
    expect(second).toBeGreaterThan(first)
  })

  it('is strictly increasing across many same-millisecond calls', () => {
    const counter = new RoundEpochCounter()
    let last = counter.next(2000, null)
    for (let i = 0; i < 50; i += 1) {
      const next = counter.next(2000, null)
      expect(next).toBeGreaterThan(last)
      last = next
    }
  })

  it('survives a clock step-back and still increases past its own prior return', () => {
    const counter = new RoundEpochCounter()
    const first = counter.next(5000, null)
    const steppedBack = counter.next(1000, null)
    expect(steppedBack).toBeGreaterThan(first)
  })

  it('a fresh counter after a restart falls back to the DB-derived value (never below it)', () => {
    const counter = new RoundEpochCounter()
    const epoch = counter.next(1000, 5000)
    expect(epoch).toBe(deriveRoundEpoch(5000, 1000))
  })
})

describe('RearmDebounce (Ruling 23 Addendum 6(ww)/review C4d finding 10)', () => {
  it('allows the first re-arm for a link immediately, debounces a repeat within the window', () => {
    const debounce = new RearmDebounce()
    expect(debounce.shouldRearm('link-1', 1000, 30_000)).toBe(true)
    expect(debounce.shouldRearm('link-1', 1500, 30_000)).toBe(false)
    expect(debounce.shouldRearm('link-1', 40_000, 30_000)).toBe(true)
  })

  it('record() (a re-arm path with its own gating) makes the OTHER paths see it happened', () => {
    const debounce = new RearmDebounce()
    // The register-timer fallback or the digest re-arm fires on its own condition and records.
    debounce.record('link-2', 10_000)
    // scheduleBinding's own debounce check, moments later, must see it and refuse.
    expect(debounce.shouldRearm('link-2', 10_500, 30_000)).toBe(false)
    expect(debounce.shouldRearm('link-2', 41_000, 30_000)).toBe(true)
  })

  it('tracks each link independently', () => {
    const debounce = new RearmDebounce()
    expect(debounce.shouldRearm('link-a', 1000, 30_000)).toBe(true)
    expect(debounce.shouldRearm('link-b', 1000, 30_000)).toBe(true)
  })
})

describe('roundBudgetMs (R10.1/A-arith(2))', () => {
  it('is monotonic in candidate environment count and capped', () => {
    const small = roundBudgetMs(1)
    const large = roundBudgetMs(1000)
    expect(small).toBeGreaterThan(0)
    expect(large).toBeGreaterThanOrEqual(small)
  })
})

describe('selectRoundPage (R10.4)', () => {
  function link(id: string, pairedAt: number, lastRoundAt: number | null): PageCandidateLink {
    return { linkDeviceId: id, pairedAt, lastRoundAt }
  }

  it('wanted links come first, in pairedAt ascending order, regardless of last_round_at', () => {
    const candidates = [
      link('a', 300, 1),
      link('b', 100, 999), // wanted, but paired most recently among wanted
      link('c', 200, 1)
    ]
    const wanted = new Set(['a', 'b'])
    const page = selectRoundPage(candidates, wanted)
    expect(page.map((p) => p.linkDeviceId)).toEqual(['b', 'a', 'c'])
  })

  it('the remainder is ordered by last_round_at ascending, NULLS FIRST', () => {
    const candidates = [link('a', 10, 500), link('b', 20, null), link('c', 30, 100)]
    const page = selectRoundPage(candidates, new Set())
    expect(page.map((p) => p.linkDeviceId)).toEqual(['b', 'c', 'a'])
  })

  it('ties in last_round_at break on pairedAt ascending then deviceId ascending', () => {
    const candidates = [link('z', 5, null), link('a', 5, null), link('m', 1, null)]
    const page = selectRoundPage(candidates, new Set())
    expect(page.map((p) => p.linkDeviceId)).toEqual(['m', 'a', 'z'])
  })

  it('is capped at LINK_BINDING_PROBE_SLOTS', () => {
    const candidates = Array.from({ length: LINK_BINDING_PROBE_SLOTS + 5 }, (_, i) =>
      link(`link_${i}`, i, null)
    )
    const page = selectRoundPage(candidates, new Set())
    expect(page).toHaveLength(LINK_BINDING_PROBE_SLOTS)
  })
})

describe('RoundTokenBucket (R10.6/P1)', () => {
  it('caps rounds at LINK_BINDING_MAX_ROUNDS_PER_MIN before refill', () => {
    const bucket = new RoundTokenBucket(0)
    let taken = 0
    for (let i = 0; i < LINK_BINDING_MAX_ROUNDS_PER_MIN + 2; i += 1) {
      if (bucket.take(0)) {
        taken += 1
      }
    }
    expect(taken).toBe(LINK_BINDING_MAX_ROUNDS_PER_MIN)
  })

  it('refills at one token per LINK_BINDING_MIN_KICK_INTERVAL_MS', () => {
    const bucket = new RoundTokenBucket(0)
    for (let i = 0; i < LINK_BINDING_MAX_ROUNDS_PER_MIN; i += 1) {
      expect(bucket.take(0)).toBe(true)
    }
    expect(bucket.take(0)).toBe(false)
    expect(bucket.take(LINK_BINDING_MIN_KICK_INTERVAL_MS)).toBe(true)
  })
})

describe('LinkBindingRerunFlag (v6 protocol M8)', () => {
  it('starts unwanted, in sweep mode', () => {
    const flag = new LinkBindingRerunFlag()
    expect(flag.wanted).toBe(false)
    expect(flag.mode).toBe('sweep')
  })

  it('a sweep request then a contest_search request upgrades the mode (never downgraded)', () => {
    const flag = new LinkBindingRerunFlag()
    flag.request('sweep')
    expect(flag.mode).toBe('sweep')
    flag.request('contest_search')
    expect(flag.mode).toBe('contest_search')
    // A later sweep request must not downgrade a standing contest_search request.
    flag.request('sweep')
    expect(flag.mode).toBe('contest_search')
  })

  it('consume() returns the mode and resets both fields', () => {
    const flag = new LinkBindingRerunFlag()
    flag.request('contest_search')
    expect(flag.consume()).toBe('contest_search')
    expect(flag.wanted).toBe(false)
    expect(flag.mode).toBe('sweep')
  })
})

describe('scheduleBindingPatch (R13.1, Ruling 23(j)/FC-1)', () => {
  it('inbound_contact NEVER signals a consecutive_failures reset — only a next_attempt_after clamp', () => {
    const patch = scheduleBindingPatch('inbound_contact', null, 1000)
    expect(patch.kicks).toBe(true)
    expect(patch.addToWanted).toBe(true)
    expect(patch.nextAttemptAfter).toBe(1000 + LINK_BINDING_MIN_KICK_INTERVAL_MS)
    // The patch shape carries no consecutiveFailures field at all — the only writer of that
    // counter is the round settle (R14.2), never a kick.
    expect('consecutiveFailures' in patch).toBe(false)
  })

  it('peer_confirmed behaves identically to inbound_contact', () => {
    const patch = scheduleBindingPatch('peer_confirmed', 5000, 1000)
    expect(patch.nextAttemptAfter).toBe(Math.min(5000, 1000 + LINK_BINDING_MIN_KICK_INTERVAL_MS))
  })

  it('the clamp only ever brings next_attempt_after FORWARD, never past this host’s own floor', () => {
    const now = 1000
    const floor = now + LINK_BINDING_MIN_KICK_INTERVAL_MS
    // an existing next_attempt_after further out than the floor is clamped down to the floor
    const farFuture = scheduleBindingPatch('inbound_contact', floor + 100_000, now)
    expect(farFuture.nextAttemptAfter).toBe(floor)
    // an existing next_attempt_after already sooner than the floor is left alone (never delayed)
    const alreadySoon = scheduleBindingPatch('inbound_contact', now + 1, now)
    expect(alreadySoon.nextAttemptAfter).toBe(now + 1)
  })

  it('a sweep_candidate reason adds to wanted but does not kick and does not touch next_attempt_after', () => {
    const patch = scheduleBindingPatch('sweep_candidate', 5000, 1000)
    expect(patch.kicks).toBe(false)
    expect(patch.addToWanted).toBe(true)
    expect(patch.nextAttemptAfter).toBeUndefined()
  })
})

describe('createInFlightGuard (R10.2)', () => {
  it('a second call for the same key while the first is still running reports busy', async () => {
    let clock = 0
    const guard = createInFlightGuard(() => clock)
    let releaseFirst: (() => void) | undefined
    const first = guard.guarded(
      'prover:env_1',
      10_000,
      () => new Promise((resolve) => (releaseFirst = () => resolve('ok')))
    )
    const second = await guard.guarded('prover:env_1', 10_000, async () => 'should-not-run')
    expect(second).toBe('busy')
    releaseFirst?.()
    expect(await first).toBe('ok')
  })

  it('the entry is removed in a finally, so a THIRD call after the first settles is not busy', async () => {
    const guard = createInFlightGuard(() => 0)
    await guard.guarded('prover:env_1', 10_000, async () => 'ok')
    expect(guard.size()).toBe(0)
    const result = await guard.guarded('prover:env_1', 10_000, async () => 'ok-again')
    expect(result).toBe('ok-again')
  })

  it('the entry is removed in a finally even when the guarded call throws', async () => {
    const guard = createInFlightGuard(() => 0)
    await expect(
      guard.guarded('prover:env_1', 10_000, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(guard.size()).toBe(0)
  })

  it('different purposes/keys never collide (prover:X vs pump:X)', async () => {
    let clock = 0
    const guard = createInFlightGuard(() => clock)
    let release: (() => void) | undefined
    void guard.guarded('prover:env_1', 10_000, () => new Promise((r) => (release = () => r('ok'))))
    const pumpResult = await guard.guarded('pump:env_1', 10_000, async () => 'pump-ran')
    expect(pumpResult).toBe('pump-ran')
    release?.()
  })

  it('a stale entry (older than maxDurationMs + INFLIGHT_GRACE_MS) is evicted and audited, never obeyed', async () => {
    let clock = 0
    const guard = createInFlightGuard(() => clock)
    // Start a call that never resolves — simulating a wedged entry (a BUG under R4.6, per design).
    void guard.guarded('prover:env_1', 1_000, () => new Promise(() => undefined))
    clock = 1_000 + LINK_BINDING_INFLIGHT_GRACE_MS + 1
    let evicted = false
    const result = await guard.guarded(
      'prover:env_1',
      1_000,
      async () => 'fresh',
      () => {
        evicted = true
      }
    )
    expect(evicted).toBe(true)
    expect(result).toBe('fresh')
  })
})
