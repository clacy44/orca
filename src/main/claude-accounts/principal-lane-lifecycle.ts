import { rmSync } from 'node:fs'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  clearLaneWipePending,
  markLaneWipePending,
  releaseUnconfirmedLaneWipe
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
 * re-push is still judged against what the lane last held). Only the revoke arm removes them.
 */

export type LaneWipeReason = 'last-connection-close' | 'startup' | 'grant-revoked'

export type StartupLaneWipeOptions = {
  /** Trigger 4: observe, record the watermark, never rotate. Owned by the startup pass alone. */
  syncLaneObserveOnly(laneId: string): Promise<void>
  /** Total deadline across every lane — this pass is awaited in front of the app window. */
  budgetMs?: number
}

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
/**
 * The whole startup pass's budget, because it is awaited in front of the app window.
 *
 * Each darwin attempt awaits a STRICT Keychain delete bounded only by its own 3 s command
 * timeout, so three lanes against a locked or prompting Keychain is ~27 s of black screen. A lane
 * the budget cuts short is left wipe-pending, which fails its launches closed until a push.
 */
const STARTUP_WIPE_BUDGET_MS = 15_000

export class PrincipalLaneLifecycle {
  constructor(private readonly deps: PrincipalLaneLifecycleDeps) {}

  /** The principal's last authenticated socket closed, or their idle timeout fired. */
  wipeOnLastConnectionClose(laneId: string): Promise<LaneWipeOutcome> {
    return this.wipe(laneId, 'last-connection-close')
  }

  /**
   * The startup order §2f fixes: observe-only sync (which records the watermark) → wipe → seed.
   *
   * Taking the watermark BEFORE the wipe is what refuses a stale re-push into a lane that is now
   * empty; taking it after would watermark nothing and let an older desktop blob land under a
   * daemon session that has since rotated.
   */
  async wipeResidentLanesAtStartup(
    laneIds: readonly string[],
    options: StartupLaneWipeOptions
  ): Promise<LaneWipeOutcome[]> {
    const deadlineAt = Date.now() + (options.budgetMs ?? STARTUP_WIPE_BUDGET_MS)
    const outcomes: LaneWipeOutcome[] = []
    for (const laneId of laneIds) {
      if (Date.now() >= deadlineAt) {
        outcomes.push(
          this.refuseWipe(laneId, 'startup', 'the startup wipe ran out of its total budget')
        )
        continue
      }
      await options.syncLaneObserveOnly(laneId)
      outcomes.push(await this.wipe(laneId, 'startup', { deadlineAt }))
    }
    return outcomes
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

  private async wipe(
    laneId: string,
    reason: LaneWipeReason,
    options: { finalize?: (laneDir: string) => void; deadlineAt?: number } = {}
  ): Promise<LaneWipeOutcome> {
    const laneDir = this.deps.resolveLaneDir(laneId)
    if (!laneDir) {
      return this.deps.laneDirExists(laneId)
        ? this.refuseWipe(laneId, reason, 'Orca could not prove it owns that lane directory')
        : { laneId, reason, removed: [], completed: true, laneRemoved: false }
    }
    // Set BEFORE anything is aborted: the start-side fence has to be closed for the whole
    // sequence, or the tick a millisecond later spawns a probe into the lane being swept.
    const sequence = markLaneWipePending(laneId)
    const removed: string[] = []
    for (let attempt = 1; attempt <= WIPE_ATTEMPTS; attempt += 1) {
      const swept = await this.attemptWipe(laneId, laneDir, options.finalize)
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
    // The mark stays set: launches keep failing closed and no surface may say the lane is empty.
    // The SEQUENCE ends here though, so a later push into the lane can void the mark rather than
    // inheriting a latch that would skip this lane's usage probe for the rest of the process.
    releaseUnconfirmedLaneWipe(laneId, sequence)
    console.warn(`[principal-lane] Lane wipe did not confirm empty; leaving it wipe-pending`)
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
    releaseUnconfirmedLaneWipe(laneId, sequence)
    console.warn(`[principal-lane] Lane not wiped: ${why}; leaving it wipe-pending`)
    this.deps.onLaneWiped?.(laneId)
    return { laneId, reason, removed: [], completed: false, laneRemoved: false }
  }

  private pastDeadline(deadlineAt: number | undefined): boolean {
    return deadlineAt !== undefined && Date.now() >= deadlineAt
  }

  /** One pass of the fence. `null` = the wipe is not confirmed; the mark must stay set. */
  private async attemptWipe(
    laneId: string,
    laneDir: string,
    finalize?: (laneDir: string) => void
  ): Promise<string[] | null> {
    return this.deps.serializeLaneWrite(laneId, async () => {
      if (!(await this.confirmProbesDead(laneId))) {
        return null
      }
      try {
        const removed = await wipeLaneCredentials(
          laneDir,
          this.deps.platform ? { platform: this.deps.platform } : {}
        )
        finalize?.(laneDir)
        return removed
      } catch (error) {
        // `logout_incomplete` is the sweep refusing to report a wipe over a directory that kept
        // re-growing a credential. Anything else is a real fault and must not read as done either.
        if (!isClaudeLaneRefusal(error)) {
          console.warn('[principal-lane] Lane credential sweep failed:', error)
        }
        return null
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
