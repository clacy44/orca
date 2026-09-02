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
  LINK_BINDING_PARTIAL_RETRY_MS,
  LINK_BINDING_PEER_TEXT_CLAMP,
  LINK_BINDING_RATE_WINDOW_MS
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
import { createMaintenanceTick } from './link-binding-prover-maintenance'

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
  // S10-16 C4a: arm()'s one-shot startup-delay timer, tracked separately from `sweepTimer` (its
  // own periodic re-arm) so disarm()/stop() can actually cancel it — previously fired-and-
  // forgot via the untracked `scheduleTimer` helper, which leaked a live timer past disarm()
  // whenever arm() ran but the startup delay hadn't elapsed yet.
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  // S10-16 C4a: the partial-completeness retry timer (below) — same leak, same fix. A round with
  // no `linkBindingSelfView` installed yet returns `partial` immediately, so this fires on the
  // very first armed startup round of any runtime that hasn't wired R9 yet (most tests).
  let partialRetryTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  // R13 trigger table/R13.4/Ruling 23 Addendum 4(hh): the environment-set digest re-arm and the
  // sweep-owned deletion — split into link-binding-prover-maintenance.ts (Ruling 23(m): a split
  // is the only remedy for the 300-line gate).
  const runMaintenanceTick = createMaintenanceTick(runtime, capabilityCache)

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
      .catch((error: unknown) => {
        // F17: prefer loud degradation — a round exception (e.g. a mid-round row-cap error) no
        // longer vanishes silently; it gets one audit row (best-effort: the audit write itself
        // must never throw an unhandled rejection out of this handler — e.g. a DB closed
        // mid-shutdown) and the round is treated as `partial` (never a completeness signal it
        // did not earn) so the caller's own book-keeping still proceeds.
        try {
          const db = runtime.getOrchestrationDb()
          // Ruling 23 Addendum 4(ff)/finding 9: a host-constant code plus a length-bounded
          // sanitised message — never an unbounded raw `error.message` (a persistent
          // `LinkBindingCapError` from `putScanFact` would otherwise produce one full-size row
          // per failed round indefinitely) — and metered like every other C4/C4a/C4b audit row.
          const rawMessage = error instanceof Error ? error.message : String(error)
          const gate = db.checkAndBumpRate({
            subjectKey: 'linkbind:round',
            verb: 'linkBindingRoundErrorAudit',
            windowMs: LINK_BINDING_RATE_WINDOW_MS,
            limit: 1
          })
          if (gate.allowed) {
            db.writeAgentAudit({
              agentId: null,
              actorPaneKey: null,
              actorHostId: null,
              verb: 'linkBinding',
              outcome: 'round_error',
              reasonCode: JSON.stringify({
                code: 'round_error',
                detail: rawMessage.slice(0, LINK_BINDING_PEER_TEXT_CLAMP)
              })
            })
          }
        } catch {
          // best-effort only — the round already failed; do not let the audit write mask it
          // with a SECOND unhandled failure.
        }
        return { completeness: 'partial', evaluatedLinkIds: [] } as const
      })
      .then((outcome) => {
        roundInFlight = false
        if (outcome && outcome.completeness === 'partial' && !stopped) {
          if (partialRetryTimer) {
            clearTimeout(partialRetryTimer)
          }
          partialRetryTimer = setTimeout(() => {
            partialRetryTimer = null
            attemptRound('sweep')
          }, LINK_BINDING_PARTIAL_RETRY_MS)
          partialRetryTimer.unref?.()
        }
        if (rerun.wanted) {
          const nextMode = rerun.consume()
          attemptRound(nextMode)
        }
      })
  }

  return {
    scheduleBinding(linkDeviceId: string, reason: ScheduleBindingReason): void {
      const db = runtime.getOrchestrationDb()
      // Ruling 23 Addendum 4(aa)/review C4b finding 2: a contested link is excluded from ALL
      // scheduling — inbound contact included. No schedule write, no `wanted.add`, no kick. Keyed
      // on the BINDING row's own `state` (never `peer_link_attempts`, a table the unshipped-v40
      // repair may drop and recreate), matching the round exclusion (link-binding-prover-round.ts).
      const binding = db.getPeerLinkBinding(linkDeviceId)
      if (binding?.state === 'contested') {
        return
      }
      const now = Date.now()
      const attempt = db.getBindingAttempt(linkDeviceId)
      const patch = scheduleBindingPatch(reason, attempt?.nextAttemptAfter ?? null, now)
      db.putBindingAttempt(linkDeviceId)
      const current = db.getBindingAttempt(linkDeviceId)
      // Ruling 23 Addendum 4(cc)/review C4b finding 4: the FIRST inbound contact after a park
      // re-arms IMMEDIATELY — no elapsed-time gate (the prior `>= LINK_BINDING_PARK_REARM_MS`
      // gate delayed the first re-arm by up to 6h). The register timer is the FALLBACK for a
      // park that never receives contact — that path lives in link-binding-prover-round.ts's
      // candidate-selection loop, gated on the same constant.
      let rearmedOutcome: 'pending' | undefined
      let rearmedNoWinner: number | undefined
      if (
        (reason === 'inbound_contact' || reason === 'peer_confirmed') &&
        current?.lastOutcome === 'unpaired_parked'
      ) {
        rearmedOutcome = 'pending'
        rearmedNoWinner = 0
      }
      if (patch.nextAttemptAfter !== undefined || rearmedOutcome !== undefined) {
        db.settleBindingAttempt(linkDeviceId, {
          lastAttemptAt: current?.lastAttemptAt ?? now,
          lastRoundAt: current?.lastRoundAt ?? now,
          lastOutcome: rearmedOutcome ?? current?.lastOutcome ?? 'pending',
          lastDetail: current?.lastDetail ?? null,
          consecutiveFailures: current?.consecutiveFailures ?? 0,
          consecutiveNoWinner: rearmedNoWinner ?? current?.consecutiveNoWinner ?? 0,
          nextAttemptAfter:
            patch.nextAttemptAfter !== undefined
              ? patch.nextAttemptAfter
              : (current?.nextAttemptAfter ?? null)
        })
      }
      if (patch.addToWanted) {
        wanted.add(linkDeviceId)
      }
      // F19: LEADING-edge debounce — fire the kick now (R13.1's whole point is faster than the
      // sweep) and then ignore further kicks for LINK_BINDING_KICK_DEBOUNCE_MS. The prior
      // trailing-edge debounce reset on every call, so steady traffic faster than the debounce
      // window prevented the kick from ever firing at all (bounded only by the 60s sweep).
      // Ruling 23 Addendum 4(bb)/review C4b finding 3: the leading-edge semantics are kept
      // (the timer starts now, synchronously) but the round itself is deferred with
      // `setTimeout(…, 0)` — R8.6 says a kick never runs a round's synchronous prefix (a disk
      // read, up to 8 attempt-row writes) on the caller's own stack, and `scheduleBinding` is
      // called at the tail of five peer-facing RPC handlers.
      if (patch.kicks && !stopped && !kickTimer) {
        setTimeout(() => attemptRound('sweep'), 0)
        kickTimer = setTimeout(() => {
          kickTimer = null
        }, LINK_BINDING_KICK_DEBOUNCE_MS)
        kickTimer.unref?.()
      }
    },
    arm(): void {
      if (sweepTimer || stopped) {
        return
      }
      startupTimer = setTimeout(() => {
        startupTimer = null
        const now = Date.now()
        runMaintenanceTick(now)
        attemptRound('sweep')
      }, LINK_BINDING_STARTUP_DELAY_MS)
      startupTimer.unref?.()
      const tick = (): void => {
        if (stopped) {
          return
        }
        const now = Date.now()
        runMaintenanceTick(now)
        attemptRound('sweep')
        sweepTimer = setTimeout(tick, LINK_BINDING_SWEEP_MS)
        sweepTimer.unref?.()
      }
      sweepTimer = setTimeout(tick, LINK_BINDING_SWEEP_MS)
      sweepTimer.unref?.()
    },
    disarm(): void {
      if (startupTimer) {
        clearTimeout(startupTimer)
        startupTimer = null
      }
      if (sweepTimer) {
        clearTimeout(sweepTimer)
        sweepTimer = null
      }
      if (kickTimer) {
        clearTimeout(kickTimer)
        kickTimer = null
      }
      if (partialRetryTimer) {
        clearTimeout(partialRetryTimer)
        partialRetryTimer = null
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
      if (startupTimer) {
        clearTimeout(startupTimer)
      }
      if (sweepTimer) {
        clearTimeout(sweepTimer)
      }
      if (kickTimer) {
        clearTimeout(kickTimer)
      }
      if (partialRetryTimer) {
        clearTimeout(partialRetryTimer)
      }
      startupTimer = null
      sweepTimer = null
      kickTimer = null
      partialRetryTimer = null
    }
  }
}
