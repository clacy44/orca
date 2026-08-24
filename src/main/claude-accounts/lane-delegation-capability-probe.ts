// Chair decision (S9, capability-probe stickiness): a failed `agent.identity-lanes.v1` probe
// (transport error, timeout, non-ok status) must never mark a host `unsupported` — that stays
// reserved for an ok `status.get` whose capabilities explicitly omit it. This class is the cached
// per-host state that used to be a single `boolean | null` on `LaneDelegationPushClient`; a failure
// now leaves it `unknown` and re-probes on the next trigger with capped exponential backoff instead
// of latching `false` until the process restarts.

export type LaneCapabilityProbeState = 'unknown' | 'supported' | 'unsupported'

const INITIAL_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 60_000
const UNSUPPORTED_TTL_MS = 10 * 60 * 1000

export type LaneCapabilityProbeOptions = {
  hostId: string
  now?: () => number
  log?: (line: string) => void
}

/**
 * One host's cached probe result, with the retry/expiry timing that keeps a transient failure from
 * becoming a sticky "unsupported". Never logs a retry, only an actual state change (rule: one line
 * per transition).
 */
export class LaneCapabilityProbe {
  private state: LaneCapabilityProbeState = 'unknown'
  private consecutiveFailures = 0
  private nextAttemptAt = 0
  private unsupportedAt: number | null = null
  private readonly hostId: string
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(options: LaneCapabilityProbeOptions) {
    this.hostId = options.hostId
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.info(line))
  }

  /** True once an ok probe has confirmed the host advertises the capability. */
  get supported(): boolean {
    return this.state === 'supported'
  }

  get currentState(): LaneCapabilityProbeState {
    return this.state
  }

  /** Whether the caller should spend a real `status.get` right now, or reuse the cached answer. */
  shouldAttempt(): boolean {
    this.expireUnsupportedIfStale()
    if (this.state !== 'unknown') {
      return false
    }
    return this.now() >= this.nextAttemptAt
  }

  /** An ok `status.get` resolved — `hasCapability` is its one true, explicit answer. */
  recordSuccess(hasCapability: boolean): void {
    this.consecutiveFailures = 0
    this.nextAttemptAt = 0
    if (hasCapability) {
      this.unsupportedAt = null
      this.transition('supported', 'capability confirmed')
    } else {
      this.unsupportedAt = this.now()
      this.transition('unsupported', 'ok status.get; capability explicitly absent')
    }
  }

  /** Transport error, timeout, or non-ok status: transient — reschedule, never mark unsupported. */
  recordFailure(): void {
    this.consecutiveFailures += 1
    const backoff = Math.min(
      MAX_BACKOFF_MS,
      INITIAL_BACKOFF_MS * 2 ** (this.consecutiveFailures - 1)
    )
    this.nextAttemptAt = this.now() + backoff
    this.transition('unknown', 'probe failed; treated as transient')
  }

  /**
   * Reconnect / environment change / re-pair: clears a confirmed `unsupported` immediately, ahead
   * of its TTL. Not a backoff bypass — an `unknown` host mid-backoff (a transient failure) still
   * waits out its window, and a confirmed `supported` host is never re-verified.
   */
  forceReprobe(reason: string): void {
    if (this.state !== 'unsupported') {
      return
    }
    this.consecutiveFailures = 0
    this.nextAttemptAt = 0
    this.unsupportedAt = null
    this.transition('unknown', reason)
  }

  private expireUnsupportedIfStale(): void {
    if (this.state !== 'unsupported' || this.unsupportedAt === null) {
      return
    }
    if (this.now() - this.unsupportedAt >= UNSUPPORTED_TTL_MS) {
      this.consecutiveFailures = 0
      this.nextAttemptAt = 0
      this.unsupportedAt = null
      this.transition('unknown', `unsupported TTL (${UNSUPPORTED_TTL_MS}ms) expired`)
    }
  }

  private transition(next: LaneCapabilityProbeState, reason: string): void {
    if (this.state === next) {
      return
    }
    const previous = this.state
    this.state = next
    this.log(
      `[lane-delegation] ${this.hostId} agent.identity-lanes.v1 capability ${previous} -> ${next} (${reason})`
    )
  }
}
