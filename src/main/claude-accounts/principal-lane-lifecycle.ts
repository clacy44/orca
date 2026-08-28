import { rmSync } from 'node:fs'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  clearLaneWipePending,
  forceReleaseLaneWipeLatch,
  markLaneWipePending,
  releaseUnconfirmedLaneWipe,
  releaseUnconfirmedLaneWipeBudgetExhausted
} from './lane-wipe-pending'
import { wipeLaneCredentials } from './principal-lane-credential-sweep'

/**
 * §2f's lifecycle: when a lane's credential stops being resident, and what "wiped" has to mean.
 *
 * Three triggers, one sequence. The close of the PRINCIPAL's last connection, the next Orca
 * start (a crash never runs the close handler), and the revoke of the principal's last grant all
 * arrive here, and each runs: mark wipe-pending → abort every in-flight usage probe and wait for
 * its `claude` to die → sweep → re-read → clear the mark. Nothing may report the wipe done before
 * the clean read-back, because a probe that slipped the start-side fence can put a full
 * credential back between the two.
 *
 * The watermark and the lane directory SURVIVE a wipe (the desktop re-pushes on reconnect, and a
 * re-push is still judged against what the lane last held). Only the revoke and deprovision arms
 * remove them.
 *
 * S9-L1 §fenceWiring / the login model: the residency window is now unbounded — from login until
 * logout, not from push until the earliest of last-close/idle/restart — so the two CHURN-driven
 * wipes go. `wipeOnLastConnectionClose` (a socket closing) and `wipeResidentLanesAtStartup` (every
 * process start) are deleted outright rather than re-themed: a login is a deliberate act, so only
 * a deliberate act — logout, revoke or deprovision — may undo it. `principal-lane-startup-wipe.ts`
 * goes with the startup arm. This is a real confidentiality-window regression against a co-tenant
 * (an independently revocable grant sits at rest longer than a copy of the desktop's own
 * credential used to), flagged rather than landed silently — see S9-L1 plan §7 question 12.
 */

export type LaneWipeReason = 'explicit-logout' | 'grant-revoked' | 'deprovision'

export type LaneWipeOutcome = {
  laneId: string
  reason: LaneWipeReason
  /** Artifact names the sweep removed, for the host's own log. Never credential bytes. */
  removed: string[]
  /** False when the probe could not be confirmed dead, or the sweep never read back clean. */
  completed: boolean
  /** Revoke only: the lane directory and its watermark went with the principal's last grant. */
  laneRemoved: boolean
}

export type PrincipalLaneLifecycleDeps = {
  resolveLaneDir(laneId: string): string | null
  /**
   * Whether ANYTHING sits at the lane's path, ownership unproved.
   *
   * `resolveLaneDir` answers null for four reasons and only one of them — nothing there — means
   * there is nothing to wipe; a lost marker, an EACCES on the path or a planted link all name a
   * directory that may be holding `.credentials.json` right now.
   */
  laneDirExists(laneId: string): boolean
  /** The lane's write queue, so a wipe cannot interleave with a push into the same lane. */
  serializeLaneWrite<T>(laneId: string, run: () => Promise<T>): Promise<T>
  /** Aborts the lane's probes and resolves once each probe's `claude` is gone (§2k's kill half). */
  invalidateProbes(laneId: string): Promise<void>
  /**
   * S9-L1 §fenceWiring: the state-transition half of cancel for every in-flight login session of
   * this lane. MUST be synchronous and MUST NOT return a promise — taken in the SAME synchronous
   * step as `markLaneWipePending`, with no `await` between them, or the induction gap reopens.
   */
  cancelLaneLoginSessions?(laneId: string): void
  /**
   * S9-L1 §fenceWiring: the destructive half — sweeps every cancelled session's half-written
   * `<laneAccountId>` directory. Run ONLY inside the fence's own `serializeLaneWrite` turn
   * (`attemptWipe`), never concurrently with an admitted capture.
   */
  sweepCancelledLoginDirs?(laneId: string): Promise<void>
  platform?: NodeJS.Platform
  /**
   * Fired on BOTH arms: it says the lane CHANGED, not that the wipe succeeded (§2h).
   *
   * The give-up arm is where outstanding switch requests most need their refusal — every launch
   * into that lane now fails closed — and where subscribers need to re-read the sticky
   * `laneWipePending` the give-up just left set.
   */
  onLaneWiped?(laneId: string): void
  /** How long the fence waits for a probe's process to be confirmed dead. */
  probeDeathTimeoutMs?: number
  /** Injected so the retry arm is assertable without real timers. */
  wait?(ms: number): Promise<void>
}

/** A wipe that cannot confirm the fence is retried, never reported done (§2f). */
const WIPE_ATTEMPTS = 3
const PROBE_DEATH_TIMEOUT_MS = 10_000

export class PrincipalLaneLifecycle {
  constructor(private readonly deps: PrincipalLaneLifecycleDeps) {}

  /**
   * `accounts.lane.logout` — a deliberate, explicit act by the lane's own principal (S9-L1
   * §modules D). The directory and its watermark SURVIVE: a re-login is still the same lane.
   */
  wipeOnExplicitLogout(laneId: string): Promise<LaneWipeOutcome> {
    return this.wipe(laneId, 'explicit-logout')
  }

  /**
   * The revoked grant was its principal's LAST: the directory and the watermark go too.
   *
   * The credential sweep still runs first, so a directory removal that fails part-way has already
   * removed the secrets rather than leaving them under a lane nothing claims.
   */
  async removeLaneOnLastGrantRevoked(laneId: string): Promise<LaneWipeOutcome> {
    let laneRemoved = false
    // Removed INSIDE the sweep's own serialized write and under the still-set wipe mark: a push
    // that entered the lane's queue between the two would otherwise be told it succeeded and then
    // have its whole lane directory — marker, provenance, settings, transcripts — removed under it.
    const outcome = await this.wipe(laneId, 'grant-revoked', {
      finalize: (laneDir) => {
        rmSync(laneDir, { recursive: true, force: true })
        laneRemoved = true
      }
    })
    // A wipe that never confirmed empty leaves the directory, the watermark AND the credential in
    // place: the mark stays set, so the lane keeps failing launches closed until a wipe confirms.
    return { ...outcome, laneRemoved }
  }

  /**
   * Deprovision: same shape as a revoke — sweep, then remove the directory INSIDE the fence's own
   * serialized turn — reachable from a caller (`principal-lane-consent-service.ts`) that does not
   * hold a `PrincipalLaneStore`/`PrincipalLaneLifecycle` of its own today. `finalize` is the
   * caller's own directory removal (`deprovisionPrincipalLane`), threaded through so it runs
   * atomically with the sweep rather than as an unguarded second step after this resolves.
   */
  async removeLaneOnDeprovision(
    laneId: string,
    finalize: (laneDir: string) => void
  ): Promise<LaneWipeOutcome> {
    let laneRemoved = false
    const outcome = await this.wipe(laneId, 'deprovision', {
      finalize: (laneDir) => {
        finalize(laneDir)
        laneRemoved = true
      }
    })
    return { ...outcome, laneRemoved }
  }

  private async wipe(
    laneId: string,
    reason: LaneWipeReason,
    options: { finalize?: (laneDir: string) => void; deadlineAt?: number } = {}
  ): Promise<LaneWipeOutcome> {
    const laneDir = this.deps.resolveLaneDir(laneId)
    if (!laneDir) {
      if (this.deps.laneDirExists(laneId)) {
        return this.refuseWipe(laneId, reason, 'Orca could not prove it owns that lane directory')
      }
      // Nothing at rest here and no mark to set, so the induction premise below does not apply
      // to this arm — a naive edit at the mark site alone misses it entirely (§fenceWiring).
      this.deps.cancelLaneLoginSessions?.(laneId)
      return { laneId, reason, removed: [], completed: true, laneRemoved: false }
    }
    // Set BEFORE anything is aborted: the start-side fence has to be closed for the whole
    // sequence, or the tick a millisecond later spawns a probe into the lane being swept.
    const sequence = markLaneWipePending(laneId)
    // Same synchronous step as the mark above — NO `await` between them (§fenceWiring: an await
    // here reopens the induction gap a `cancel` racing `start` relies on being closed).
    this.deps.cancelLaneLoginSessions?.(laneId)
    const removed: string[] = []
    // §fenceWiring "THE LATCH RELEASE", bounded-budget arm: true once ANY attempt's sweep
    // GENUINELY ran (the probe confirmed dead, and `wipeLaneCredentials` itself re-read across
    // its own `LANE_SWEEP_PASSES` before reporting `logout_incomplete`) — never merely because
    // `confirmProbesDead` timed out, which proves nothing about whether a live process still
    // holds the credential.
    let sweepGenuinelyRan = false
    for (let attempt = 1; attempt <= WIPE_ATTEMPTS; attempt += 1) {
      const { swept, sweepGenuinelyRan: ranThisAttempt } = await this.attemptWipe(
        laneId,
        laneDir,
        options.finalize
      )
      sweepGenuinelyRan = sweepGenuinelyRan || ranThisAttempt
      for (const name of swept ?? []) {
        if (!removed.includes(name)) {
          removed.push(name)
        }
      }
      if (swept) {
        clearLaneWipePending(laneId, sequence)
        this.deps.onLaneWiped?.(laneId)
        return { laneId, reason, removed, completed: true, laneRemoved: false }
      }
      if (attempt < WIPE_ATTEMPTS && !this.pastDeadline(options.deadlineAt)) {
        await (this.deps.wait?.(0) ?? Promise.resolve())
        continue
      }
      break
    }
    // The SEQUENCE always ends here, so a later push into the lane can void the mark rather than
    // inheriting a latch that would skip this lane's usage probe for the rest of the process.
    //
    // §fenceWiring "THE LATCH RELEASE" bounded-budget arm: the mark itself releases too, but
    // ONLY when `sweepGenuinelyRan` — a probe was confirmed dead and a real sweep exhausted its
    // own bounded re-read budget. When the probe was never confirmed dead across every attempt, a
    // live process may still hold the credential, and the mark stays latched exactly as before —
    // `getLaneState` keeps reading it to fail launches closed (`principal-lane-lifecycle.test.ts`
    // "fails a lane launch closed while the wipe is pending, credential still on disk" pins that
    // arm). The operator's `orca lane wipe --person <name> --force` remains the exit for THAT
    // case, and for a second sequence still racing this one (`releaseUnconfirmedLaneWipeBudgetExhausted`
    // returns false without clearing when one is).
    if (sweepGenuinelyRan) {
      if (releaseUnconfirmedLaneWipeBudgetExhausted(laneId, sequence)) {
        console.warn(
          '[principal-lane] wipe-unconfirmed: sweep budget exhausted with the probe confirmed dead; releasing the wipe-pending mark'
        )
      } else {
        console.warn(
          '[principal-lane] Lane wipe did not confirm empty; leaving it wipe-pending (another wipe sequence still in flight on this lane)'
        )
      }
    } else {
      releaseUnconfirmedLaneWipe(laneId, sequence)
      console.warn(`[principal-lane] Lane wipe did not confirm empty; leaving it wipe-pending`)
    }
    this.deps.onLaneWiped?.(laneId)
    return { laneId, reason, removed, completed: false, laneRemoved: false }
  }

  /**
   * A lane nothing swept, reported as NOT wiped and latched wipe-pending.
   *
   * The directory may hold a full credential — that is exactly why it is not reported done — so
   * `laneState` keeps reading `absent` and every launch into it keeps failing closed.
   */
  private refuseWipe(laneId: string, reason: LaneWipeReason, why: string): LaneWipeOutcome {
    const sequence = markLaneWipePending(laneId)
    // Same synchronous step as the mark, same reason as the fence arm's (§fenceWiring: this arm
    // sets the mark, so the induction premise applies here too — deferring the sweep, not the
    // transition, since no queue turn is held on this arm).
    this.deps.cancelLaneLoginSessions?.(laneId)
    releaseUnconfirmedLaneWipe(laneId, sequence)
    console.warn(`[principal-lane] Lane not wiped: ${why}; leaving it wipe-pending`)
    this.deps.onLaneWiped?.(laneId)
    return { laneId, reason, removed: [], completed: false, laneRemoved: false }
  }

  /**
   * `orca lane wipe --person <name> --force` (§fenceWiring "THE LATCH RELEASE"): the operator's
   * deliberate, on-demand end to a latched mark — the only exit this slice ships for a wipe that
   * could never confirm the lane empty. Not a sweep — the credential the mark was protecting
   * against may still be at rest; the operator is asserting that risk is theirs to accept now.
   */
  forceReleaseWipeLatch(laneId: string): boolean {
    const cleared = forceReleaseLaneWipeLatch(laneId)
    if (cleared) {
      console.warn(
        `[principal-lane] wipe-unconfirmed: operator forced the wipe-pending latch open for this lane`
      )
      this.deps.onLaneWiped?.(laneId)
    }
    return cleared
  }

  private pastDeadline(deadlineAt: number | undefined): boolean {
    return deadlineAt !== undefined && Date.now() >= deadlineAt
  }

  /**
   * One pass of the fence. `swept: null` means not confirmed this pass; the mark must stay set.
   *
   * `sweepGenuinelyRan` distinguishes the TWO ways a pass can fail to confirm: the probe was
   * never confirmed dead (no sweep even started — a live `claude` may still be rotating this
   * lane's credential, so the bounded-budget release below must never fire) from a real sweep
   * that ran its own `LANE_SWEEP_PASSES` re-reads and still found the directory regrown (the
   * probe IS confirmed dead; what remains is a detached process this fence cannot reach).
   */
  private async attemptWipe(
    laneId: string,
    laneDir: string,
    finalize?: (laneDir: string) => void
  ): Promise<{ swept: string[] | null; sweepGenuinelyRan: boolean }> {
    return this.deps.serializeLaneWrite(laneId, async () => {
      if (!(await this.confirmProbesDead(laneId))) {
        return { swept: null, sweepGenuinelyRan: false }
      }
      try {
        // The destructive half of cancel, INSIDE this same turn — never concurrently with an
        // admitted capture (§fenceWiring).
        await this.deps.sweepCancelledLoginDirs?.(laneId)
        const removed = await wipeLaneCredentials(
          laneDir,
          this.deps.platform ? { platform: this.deps.platform } : {}
        )
        finalize?.(laneDir)
        return { swept: removed, sweepGenuinelyRan: true }
      } catch (error) {
        // `logout_incomplete` is the sweep refusing to report a wipe over a directory that kept
        // re-growing a credential — it DID run its own bounded re-read. Anything else is a real
        // fault (disk error, …), not a confirmed "kept regrowing" signal, and must not count
        // toward the bounded-budget release either.
        const sweptViaLogoutIncomplete =
          isClaudeLaneRefusal(error) && error.code === 'accounts.lane.logout_incomplete'
        if (!isClaudeLaneRefusal(error)) {
          console.warn('[principal-lane] Lane credential sweep failed:', error)
        }
        return { swept: null, sweepGenuinelyRan: sweptViaLogoutIncomplete }
      }
    })
  }

  /** Bounded: a probe that cannot be confirmed dead leaves the sweep retried, not reported done. */
  private async confirmProbesDead(laneId: string): Promise<boolean> {
    const timeoutMs = this.deps.probeDeathTimeoutMs ?? PROBE_DEATH_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), timeoutMs)
      timer.unref?.()
    })
    try {
      const outcome = await Promise.race([
        this.deps.invalidateProbes(laneId).then(() => 'dead' as const),
        expiry
      ])
      return outcome === 'dead'
    } catch (error) {
      console.warn('[principal-lane] Could not confirm the lane usage probe is dead:', error)
      return false
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * §2f's close predicate: does ANY authenticated socket of this PRINCIPAL remain?
 *
 * Not the grant's — a person connected from their desktop and their phone holds one lane through
 * two grants, and the grant-scoped predicate B2 already computes (`hasOtherConnections`, keyed by
 * `deviceToken`) would wipe their live credential when either device disconnected.
 */
export function principalHasRemainingConnections(args: {
  principalId: string
  connectedDeviceIds: readonly string[]
  principalOf(deviceId: string): string | null
}): boolean {
  return args.connectedDeviceIds.some((deviceId) => args.principalOf(deviceId) === args.principalId)
}
