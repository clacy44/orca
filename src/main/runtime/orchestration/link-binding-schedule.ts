// S10-16 C4, R10.4/R10.5/R10.6/R13.1/R13.2 (design v6) + Ruling 23(j): the scan round's schedule
// primitives — backoff, page selection, the derived host-global epoch, the round budget, the
// per-host round token bucket, the rerun flag, and the inbound-contact scheduling patch. Pure, no
// I/O — the caller (link-binding-prover.ts / link-binding-prover-round.ts) supplies every read
// and performs every write.
import {
  LINK_BINDING_BACKOFF_BASE_MS,
  LINK_BINDING_BACKOFF_MAX_MS,
  LINK_BINDING_CANDIDATE_BUDGET_MS,
  LINK_BINDING_ROUND_BUDGET_CAP_MS,
  LINK_BINDING_SCAN_CONCURRENCY,
  LINK_BINDING_PROBE_SLOTS,
  LINK_BINDING_MAX_ROUNDS_PER_MIN,
  LINK_BINDING_MIN_KICK_INTERVAL_MS,
  LINK_BINDING_INFLIGHT_GRACE_MS,
  REPLY_OUTBOX_JITTER_RATIO
} from './link-binding-constants'

// R13.2: `min(BASE * 2^n, MAX)` with +/-20% jitter (A-arith(13)). The jitter fraction is THE
// REGISTER's one 0.2 constant (REPLY_OUTBOX_JITTER_RATIO) — reused rather than restated, per
// the single-definition-site rule; the design's own text gives this curve the same +/-20% shape.
// `random` is injectable so a test can assert exact bounds without stubbing global `Math.random`.
export function linkBindingIntervalMs(
  consecutiveFailures: number,
  random: () => number = Math.random
): number {
  const n = Math.max(0, consecutiveFailures)
  const base = Math.min(LINK_BINDING_BACKOFF_BASE_MS * 2 ** n, LINK_BINDING_BACKOFF_MAX_MS)
  const jitterSpan = base * REPLY_OUTBOX_JITTER_RATIO
  // random() in [0,1) -> jitter in [-jitterSpan, +jitterSpan)
  const jitter = (random() * 2 - 1) * jitterSpan
  return Math.max(0, Math.round(base + jitter))
}

// R10.5: ONE monotonic counter per host, derived from MAX(last_round_at), never stored as its
// own column. The `+1` survives a clock step-back (P14).
export function deriveRoundEpoch(maxLastRoundAt: number | null, now: number): number {
  return Math.max(now, maxLastRoundAt ?? 0) + 1
}

// Ruling 23 Addendum 6(ww)/review C4d finding 11: `deriveRoundEpoch` alone is only strictly
// increasing while two rounds' own `now`/`MAX(last_round_at)` differ — two rounds started in the
// same millisecond derive the SAME epoch from the DB alone. This counter additionally remembers
// the last epoch it actually HANDED OUT (in-memory, per prover instance — never persisted; a
// restart falls back to the DB-derived value, same as before) so every subsequent call is
// strictly greater than every previous one it returned, matching `max(previous + 1, now)`.
export class RoundEpochCounter {
  private last: number | null = null

  next(now: number, maxLastRoundAt: number | null): number {
    const seed = this.last === null ? maxLastRoundAt : Math.max(this.last, maxLastRoundAt ?? 0)
    const epoch = deriveRoundEpoch(seed, now)
    this.last = epoch
    return epoch
  }
}

// R10.1/A-arith(2): computed at round start from the candidate ENVIRONMENT count, capped.
export function roundBudgetMs(candidateEnvironmentCount: number): number {
  const perEnvironmentPhases = Math.ceil(candidateEnvironmentCount / LINK_BINDING_SCAN_CONCURRENCY)
  return Math.min(
    perEnvironmentPhases * LINK_BINDING_CANDIDATE_BUDGET_MS,
    LINK_BINDING_ROUND_BUDGET_CAP_MS
  )
}

export type PageCandidateLink = {
  linkDeviceId: string
  pairedAt: number
  lastRoundAt: number | null
}

// R10.4: THE one page-selection specification. `wanted` (put there by a kick, R13.1) is taken
// first in pairedAt ascending order, regardless of any cursor; the rest is filled by
// last_round_at ascending NULLS FIRST, tie-broken pairedAt ascending then deviceId ascending.
// `peer_link_attempts.last_round_at` IS the cursor — there is no separate cursor column
// (R10.4's deleted `page_cursor`). Capped at LINK_BINDING_PROBE_SLOTS (LINK_BINDING_MAX_PAGES_PER_ROUND
// is 1, so one page IS the round).
export function selectRoundPage(
  candidates: readonly PageCandidateLink[],
  wanted: ReadonlySet<string>
): PageCandidateLink[] {
  const wantedOrdered = candidates
    .filter((c) => wanted.has(c.linkDeviceId))
    .sort((a, b) => a.pairedAt - b.pairedAt)
  const page: PageCandidateLink[] = [...wantedOrdered]
  const chosenIds = new Set(page.map((c) => c.linkDeviceId))
  const rest = candidates
    .filter((c) => !chosenIds.has(c.linkDeviceId))
    .sort((a, b) => {
      const aRound = a.lastRoundAt ?? -Infinity
      const bRound = b.lastRoundAt ?? -Infinity
      if (aRound !== bRound) {
        return aRound - bRound
      }
      if (a.pairedAt !== b.pairedAt) {
        return a.pairedAt - b.pairedAt
      }
      return a.linkDeviceId < b.linkDeviceId ? -1 : a.linkDeviceId > b.linkDeviceId ? 1 : 0
    })
  for (const candidate of rest) {
    if (page.length >= LINK_BINDING_PROBE_SLOTS) {
      break
    }
    page.push(candidate)
  }
  return page.slice(0, LINK_BINDING_PROBE_SLOTS)
}

// R10.6 (P1): the per-host round token bucket. Capacity LINK_BINDING_MAX_ROUNDS_PER_MIN, refilled
// continuously at one token per LINK_BINDING_MIN_KICK_INTERVAL_MS (A-arith(4)) — "not a timer of
// its own": refill is computed lazily against elapsed wall-clock time at each `take` call, never a
// setInterval of its own.
export class RoundTokenBucket {
  private tokens: number
  private lastRefillAt: number

  constructor(now: number, tokens: number = LINK_BINDING_MAX_ROUNDS_PER_MIN) {
    this.tokens = tokens
    this.lastRefillAt = now
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefillAt
    if (elapsed <= 0) {
      return
    }
    const earned = elapsed / LINK_BINDING_MIN_KICK_INTERVAL_MS
    if (earned <= 0) {
      return
    }
    this.tokens = Math.min(LINK_BINDING_MAX_ROUNDS_PER_MIN, this.tokens + earned)
    this.lastRefillAt = now
  }

  // Returns true and consumes one token iff a token was available.
  take(now: number): boolean {
    this.refill(now)
    if (this.tokens < 1) {
      return false
    }
    this.tokens -= 1
    return true
  }
}

export type RoundMode = 'sweep' | 'contest_search'

// R10.6 (v6, protocol M8): the re-run flag carries the STRONGEST requested mode across a drained
// bucket — 'contest_search' > 'sweep', monotonically, until consumed. Consumed at the next
// round-start attempt (kick or sweep), never on a refill timer of its own (protocol m7).
export class LinkBindingRerunFlag {
  private _wanted = false
  private _mode: RoundMode = 'sweep'

  get wanted(): boolean {
    return this._wanted
  }

  get mode(): RoundMode {
    return this._mode
  }

  request(mode: RoundMode): void {
    this._wanted = true
    if (mode === 'contest_search') {
      this._mode = 'contest_search'
    }
  }

  // Returns the mode to run in and resets the flag (mode back to 'sweep', wanted false).
  consume(): RoundMode {
    const mode = this._mode
    this._wanted = false
    this._mode = 'sweep'
    return mode
  }
}

// Ruling 23 Addendum 6(ww)/review C4d finding 10: ONE debounce map shared by all three R13
// re-arm paths — `scheduleBinding`'s own inbound-contact re-arm, the register-timer sweep
// fallback (link-binding-prover-round.ts), and the environment-set digest re-arm
// (link-binding-prover-maintenance.ts). Before this, only `scheduleBinding` recorded a re-arm,
// so a link re-armed by either of the other two paths still got an immediate FIRST
// `scheduleBinding` re-arm right afterwards — that path's own record was invisible to the other.
export class RearmDebounce {
  private lastRearmAt = new Map<string, number>()

  // Returns true (and records `now`) iff this link may re-arm now under the window; false and
  // no write if the last re-arm — by ANY path — was within `windowMs`.
  shouldRearm(linkDeviceId: string, now: number, windowMs: number): boolean {
    const last = this.lastRearmAt.get(linkDeviceId)
    if (last !== undefined && now - last < windowMs) {
      return false
    }
    this.lastRearmAt.set(linkDeviceId, now)
    return true
  }

  // For a re-arm path that decides to fire on its OWN gating condition (not this window) — still
  // stamps the shared map so the other two paths see it happened.
  record(linkDeviceId: string, now: number): void {
    this.lastRearmAt.set(linkDeviceId, now)
  }
}

// Ruling 28(a) (C8a): 'operator_bind' is the design's `proveNow` scheduling reason — never
// peer-callable (only `orchestration-link-binding-local.ts`'s `linkBind` RPC schedules it),
// audited with caller identity by the RPC layer, and EXEMPT from both the peer-traffic kick
// debounce (link-binding-prover.ts) and the park re-arm debounce (RearmDebounce) — see
// `ScheduleBindingPatch.bypassDebounce` below.
export type ScheduleBindingReason =
  | 'inbound_contact'
  | 'peer_confirmed'
  | 'sweep_candidate'
  | 'operator_bind'

export type ScheduleBindingPatch = {
  // R13.1, Ruling 23(j)/FC-1: inbound contact is scheduling LIVENESS ONLY. It NEVER resets
  // `peer_link_attempts.consecutive_failures` — that counter's single writer stays the round
  // settle (R14.2) — and it only ever CLAMPS `next_attempt_after` DOWNWARD to this per-link floor,
  // never below it (a peer's message brings the dial forward, it does not command it) and never
  // to null. `nextAttemptAfter` is the value to write, or `undefined` when nothing changes.
  nextAttemptAfter: number | undefined
  addToWanted: boolean
  kicks: boolean
  // Ruling 28(a): true only for 'operator_bind' — the caller (link-binding-prover.ts) skips the
  // kick debounce timer and the park re-arm debounce for this one request.
  bypassDebounce: boolean
}

// R13.1's `scheduleBinding`, minus the DB write and the actual kick() call (the caller performs
// both — this function is the pure scheduling decision).
export function scheduleBindingPatch(
  reason: ScheduleBindingReason,
  currentNextAttemptAfter: number | null,
  now: number
): ScheduleBindingPatch {
  if (reason === 'inbound_contact' || reason === 'peer_confirmed' || reason === 'operator_bind') {
    const floor = now + LINK_BINDING_MIN_KICK_INTERVAL_MS
    const next = currentNextAttemptAfter === null ? floor : Math.min(currentNextAttemptAfter, floor)
    return {
      nextAttemptAfter: next,
      addToWanted: true,
      kicks: true,
      bypassDebounce: reason === 'operator_bind'
    }
  }
  return { nextAttemptAfter: undefined, addToWanted: true, kicks: false, bypassDebounce: false }
}

// R10.2: the in-flight registry — keyed per purpose (`prover:<envId>` / `pump:<envId>`), removed
// in `finally`, and a stale entry is evicted-and-audited rather than obeyed. Extracted as a
// standalone factory (rather than inlined in link-binding-prover.ts's closure) so it is directly
// testable without driving the prover's own timers.
export type InFlightGuard = {
  guarded<T>(
    key: string,
    maxDurationMs: number,
    run: () => Promise<T>,
    onStaleEvicted?: (key: string) => void
  ): Promise<T | 'busy'>
  size(): number
}

export function createInFlightGuard(clock: () => number = Date.now): InFlightGuard {
  const inFlight = new Map<string, { startedAt: number; maxDurationMs: number }>()
  return {
    async guarded<T>(
      key: string,
      maxDurationMs: number,
      run: () => Promise<T>,
      onStaleEvicted?: (key: string) => void
    ): Promise<T | 'busy'> {
      const held = inFlight.get(key)
      if (held) {
        if (clock() - held.startedAt > held.maxDurationMs + LINK_BINDING_INFLIGHT_GRACE_MS) {
          inFlight.delete(key)
          onStaleEvicted?.(key)
        } else {
          return 'busy'
        }
      }
      inFlight.set(key, { startedAt: clock(), maxDurationMs })
      try {
        return await run()
      } finally {
        inFlight.delete(key)
      }
    },
    size(): number {
      return inFlight.size
    }
  }
}
