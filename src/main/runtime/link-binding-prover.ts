// S10-16 C4, R8.6/R10.2/R10.6/R13 (design v6): the verifier's own scheduler — arm/tick/disarm,
// the R7.5 kick (`scheduleBinding`), the R10.2 per-purpose in-flight registry, the R10.6 round
// token bucket + rerun flag, and `stop()`. Installed on `OrcaRuntimeService` (the same pattern as
// `linkBindingSelfView` — `runtime.linkBindingProver`), never a bare module-level singleton, so
// two runtimes in one test process never share state.
import type { OrcaRuntimeService } from './orca-runtime'
import {
  LINK_BINDING_SWEEP_MS,
  LINK_BINDING_STARTUP_DELAY_MS,
  LINK_BINDING_KICK_DEBOUNCE_MS,
  LINK_BINDING_PARTIAL_RETRY_MS
} from './orchestration/link-binding-constants'
import {
  RoundTokenBucket,
  LinkBindingRerunFlag,
  scheduleBindingPatch,
  createInFlightGuard,
  type ScheduleBindingReason,
  type RoundMode
} from './orchestration/link-binding-schedule'
import { runOneRound, type CapabilityCache, type GuardedProbe } from './link-binding-prover-round'

export type LinkBindingProver = {
  /** R13.1: an inbound-contact/peer-confirmed/sweep scheduling request for one link. Ruling
   *  23(j)/FC-1: `inbound_contact`/`peer_confirmed` NEVER reset `consecutive_failures` — only
   *  clamp `next_attempt_after` to the per-link floor — and only those two reasons kick. */
  scheduleBinding(linkDeviceId: string, reason: ScheduleBindingReason): void
  /** R13's startup trigger and the periodic sweep timer. Idempotent — a second `arm()` is a
   *  no-op while already armed. */
  arm(): void
  disarm(): void
  /** Never blocks the caller (R8.6): fires a round attempt off the microtask queue. */
  requestRerun(mode: RoundMode): void
  health(): { inFlightCount: number; bucketWanted: boolean }
  stop(): void
}

export function createLinkBindingProver(runtime: OrcaRuntimeService): LinkBindingProver {
  const inFlightGuard = createInFlightGuard()
  const wanted = new Set<string>()
  const rerun = new LinkBindingRerunFlag()
  let bucket: RoundTokenBucket | null = null
  const capabilityCache: CapabilityCache = new Map()
  let roundInFlight = false
  let sweepTimer: ReturnType<typeof setTimeout> | null = null
  let kickTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  // R10.2: keyed per purpose (`prover:<envId>`) — the pump (C5) keys its own guard
  // `pump:<envId>`, so the two never collide even against the same environment.
  const guardedProbe: GuardedProbe = (environmentId, maxDurationMs, run) =>
    inFlightGuard.guarded(`prover:${environmentId}`, maxDurationMs, run, () => {
      runtime.getOrchestrationDb().writeAgentAudit({
        agentId: null,
        actorPaneKey: null,
        actorHostId: environmentId,
        verb: 'linkBinding',
        outcome: 'inflight_stale_evicted',
        reasonCode: null
      })
    })

  function ensureBucket(now: number): RoundTokenBucket {
    if (!bucket) {
      bucket = new RoundTokenBucket(now)
    }
    return bucket
  }

  // R10.6: one round in flight per host; a kick/sweep/startup while one runs — or while the
  // bucket is empty — sets the re-run flag and starts nothing.
  function attemptRound(mode: RoundMode): void {
    if (stopped) {
      return
    }
    const now = Date.now()
    if (roundInFlight) {
      rerun.request(mode)
      return
    }
    if (!ensureBucket(now).take(now)) {
      rerun.request(mode)
      return
    }
    roundInFlight = true
    const roundWanted = new Set(wanted)
    wanted.clear()
    void runOneRound({ runtime, mode, now, wanted: roundWanted, guardedProbe, capabilityCache })
      .catch(() => undefined)
      .then((outcome) => {
        roundInFlight = false
        if (outcome && outcome.completeness === 'partial') {
          scheduleTimer(LINK_BINDING_PARTIAL_RETRY_MS, () => attemptRound('sweep'))
        }
        if (rerun.wanted) {
          const nextMode = rerun.consume()
          attemptRound(nextMode)
        }
      })
  }

  function scheduleTimer(delayMs: number, run: () => void): void {
    const timer = setTimeout(run, delayMs)
    timer.unref?.()
  }

  return {
    scheduleBinding(linkDeviceId: string, reason: ScheduleBindingReason): void {
      const db = runtime.getOrchestrationDb()
      const attempt = db.getBindingAttempt(linkDeviceId)
      const patch = scheduleBindingPatch(reason, attempt?.nextAttemptAfter ?? null, Date.now())
      db.putBindingAttempt(linkDeviceId)
      if (patch.nextAttemptAfter !== undefined) {
        const current = db.getBindingAttempt(linkDeviceId)
        db.settleBindingAttempt(linkDeviceId, {
          lastAttemptAt: current?.lastAttemptAt ?? Date.now(),
          lastRoundAt: current?.lastRoundAt ?? Date.now(),
          lastOutcome: current?.lastOutcome ?? 'pending',
          lastDetail: current?.lastDetail ?? null,
          consecutiveFailures: current?.consecutiveFailures ?? 0,
          consecutiveNoWinner: current?.consecutiveNoWinner ?? 0,
          nextAttemptAfter: patch.nextAttemptAfter
        })
      }
      if (patch.addToWanted) {
        wanted.add(linkDeviceId)
      }
      if (patch.kicks && !stopped) {
        if (kickTimer) {
          clearTimeout(kickTimer)
        }
        kickTimer = setTimeout(() => attemptRound('sweep'), LINK_BINDING_KICK_DEBOUNCE_MS)
        kickTimer.unref?.()
      }
    },
    arm(): void {
      if (sweepTimer || stopped) {
        return
      }
      scheduleTimer(LINK_BINDING_STARTUP_DELAY_MS, () => attemptRound('sweep'))
      const tick = (): void => {
        if (stopped) {
          return
        }
        attemptRound('sweep')
        sweepTimer = setTimeout(tick, LINK_BINDING_SWEEP_MS)
        sweepTimer.unref?.()
      }
      sweepTimer = setTimeout(tick, LINK_BINDING_SWEEP_MS)
      sweepTimer.unref?.()
    },
    disarm(): void {
      if (sweepTimer) {
        clearTimeout(sweepTimer)
        sweepTimer = null
      }
      if (kickTimer) {
        clearTimeout(kickTimer)
        kickTimer = null
      }
    },
    requestRerun(mode: RoundMode): void {
      attemptRound(mode)
    },
    health(): { inFlightCount: number; bucketWanted: boolean } {
      return { inFlightCount: inFlightGuard.size(), bucketWanted: rerun.wanted }
    },
    stop(): void {
      stopped = true
      if (sweepTimer) {
        clearTimeout(sweepTimer)
      }
      if (kickTimer) {
        clearTimeout(kickTimer)
      }
      sweepTimer = null
      kickTimer = null
    }
  }
}
