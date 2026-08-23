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
  /** The lane's write queue, so a wipe cannot interleave with a push into the same lane. */
  serializeLaneWrite<T>(laneId: string, run: () => Promise<T>): Promise<T>
  /** Aborts the lane's probes and resolves once each probe's `claude` is gone (§2k's kill half). */
  invalidateProbes(laneId: string): Promise<void>
  clearResidencyRow(laneId: string): void
  removeWatermark(laneId: string): void
  /** Trigger 4: observe, record the watermark, never rotate. */
  syncLaneObserveOnly(laneId: string): Promise<void>
  platform?: NodeJS.Platform
  /** Published so subscribers re-read `laneState`/`laneWipePending` (§2h). */
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
  async wipeResidentLanesAtStartup(laneIds: readonly string[]): Promise<LaneWipeOutcome[]> {
    const outcomes: LaneWipeOutcome[] = []
    for (const laneId of laneIds) {
      await this.deps.syncLaneObserveOnly(laneId)
      outcomes.push(await this.wipe(laneId, 'startup'))
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
    const outcome = await this.wipe(laneId, 'grant-revoked', (laneDir) => {
      rmSync(laneDir, { recursive: true, force: true })
      this.deps.removeWatermark(laneId)
      laneRemoved = true
    })
    // A wipe that never confirmed empty leaves the directory, the watermark AND the credential in
    // place: the mark stays set, so the lane keeps failing launches closed until a wipe confirms.
    return { ...outcome, laneRemoved }
  }

  private async wipe(
    laneId: string,
    reason: LaneWipeReason,
    finalize?: (laneDir: string) => void
  ): Promise<LaneWipeOutcome> {
    const laneDir = this.deps.resolveLaneDir(laneId)
    if (!laneDir) {
      return { laneId, reason, removed: [], completed: true, laneRemoved: false }
    }
    // Set BEFORE anything is aborted: the start-side fence has to be closed for the whole
    // sequence, or the tick a millisecond later spawns a probe into the lane being swept.
    const sequence = markLaneWipePending(laneId)
    const removed: string[] = []
    for (let attempt = 1; attempt <= WIPE_ATTEMPTS; attempt += 1) {
      const swept = await this.attemptWipe(laneId, laneDir, finalize)
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
      if (attempt < WIPE_ATTEMPTS) {
        await (this.deps.wait?.(0) ?? Promise.resolve())
      }
    }
    // The mark stays set: launches keep failing closed and no surface may say the lane is empty.
    // The SEQUENCE ends here though, so a later push into the lane can void the mark rather than
    // inheriting a latch that would skip this lane's usage probe for the rest of the process.
    releaseUnconfirmedLaneWipe(laneId, sequence)
    console.warn(`[principal-lane] Lane wipe did not confirm empty; leaving it wipe-pending`)
    return { laneId, reason, removed, completed: false, laneRemoved: false }
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
        this.deps.clearResidencyRow(laneId)
        finalize?.(laneDir)
        return removed
      } catch (error) {
        // `clear_incomplete` is the sweep refusing to report a wipe over a directory that kept
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
