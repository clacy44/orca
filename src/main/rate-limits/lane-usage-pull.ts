import { randomUUID } from 'node:crypto'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import type { ClaudeLaneUsageAttribution } from './claude-usage-attribution'

/**
 * The per-lane usage PULL (S9 §2k, Q7).
 *
 * A pull that runs `claude` under a lane's config dir IS a live Claude process holding that
 * lane's single-use refresh token, so this module is mostly the four joins that fact forces:
 * the refresh deferral, the per-lane switch gate, the post-probe `syncLane`, and the close-wipe
 * fence — whose START side (no probe into a lane whose wipe is pending, none into an `absent`
 * lane) lives here rather than in the sweep, because a suite that tests only the kill passes
 * while the very next tick re-loads the lane it just watched being wiped.
 */

export type LaneUsageSkipReason =
  | 'wipe-pending'
  | 'lane-absent'
  | 'switch-in-progress'
  | 'stale-probe'

export type LaneUsagePullOutcome = {
  /** Lanes whose probe ran to a result that was attributed. */
  probed: string[]
  skipped: { laneId: string; reason: LaneUsageSkipReason }[]
  /** True on `win32`, where the pull is off and the statusline path feeds the bars alone. */
  disabled: boolean
}

export type LaneUsagePullDeps = {
  /** One row per LOADED lane, the same rows the attribution map keys by config dir. */
  listLoadedLanes(): readonly ClaudeLaneUsageAttribution[]
  laneStateOf(laneId: string): RuntimeTerminalLaneState
  isWipePending(laneId: string): boolean
  /** A probe that finds the lane's switch gate closed is SKIPPED, not queued (§2k). */
  isSwitchInProgress(laneId: string): boolean
  fetchUsage(input: {
    authPreparation: ClaudeRuntimeAuthPreparation
    signal: AbortSignal
  }): Promise<ProviderRateLimits>
  /** The probe is a live claude in the lane: it defers that lane's rotation for its lifetime. */
  markProbeSpawned(gateId: string, laneId: string): void
  markProbeExited(gateId: string): void
  /**
   * §2c trigger 2's SECOND arm, and explicitly NOT gated on the lane still having live PTYs: on
   * an idle lane the probe was the only member, so an ordering-only rule would skip the sync by
   * its own precondition and leave the watermark at the pre-probe sha — the rev-5 push_stale bug
   * in a new place.
   */
  syncProbedLane(laneId: string): Promise<void>
  newGateId?: () => string
  platform?: NodeJS.Platform
}

/**
 * The lane arm of the preparation the fetcher already threads — the inactive-account preview
 * shape with the lane's own dir, so `resolveOAuthCredentialReadOptions` reads the lane.
 *
 * The provenance is the lane's opaque label, never `managed:`, so `isManagedClaudeAuth` stays
 * false for a lane and the CLI supplementation path stays scoped to the shared lane.
 */
export function buildLaneUsageAuthPreparation(
  lane: ClaudeLaneUsageAttribution
): ClaudeRuntimeAuthPreparation {
  return {
    configDir: lane.configDir,
    runtime: 'host',
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: { CLAUDE_CONFIG_DIR: lane.configDir },
    stripAuthEnv: true,
    provenance: lane.provenance
  }
}

export class LaneUsagePull {
  private readonly inFlight = new Map<string, Set<AbortController>>()
  private readonly usageByLane = new Map<string, ProviderRateLimits>()

  constructor(private readonly deps: LaneUsagePullDeps) {}

  /**
   * DISABLED on `win32` (§2k Fact 2, §6's gate).
   *
   * The precedent this slice is modelled on is switched off there:
   * `getManagedUsagePanelAuthPreparation` opens with `if (process.platform === 'win32') return
   * null` (`rate-limits/claude-fetcher.ts:1059-1061`), and the code carries no comment saying
   * what that is protecting against. Until the §5 Windows probe establishes it, a lane on the
   * shared Windows host has statusline-derived usage only.
   */
  isDisabled(): boolean {
    return (this.deps.platform ?? process.platform) === 'win32'
  }

  laneUsage(laneId: string): ProviderRateLimits | null {
    return this.usageByLane.get(laneId) ?? null
  }

  /** A push or a close-wipe marks every probe in flight in that lane stale and kills it. */
  invalidateLane(laneId: string): void {
    for (const controller of this.inFlight.get(laneId) ?? []) {
      controller.abort()
    }
  }

  async run(): Promise<LaneUsagePullOutcome> {
    const outcome: LaneUsagePullOutcome = { probed: [], skipped: [], disabled: this.isDisabled() }
    if (outcome.disabled) {
      return outcome
    }
    for (const lane of this.deps.listLoadedLanes()) {
      const skip = this.startSideRefusal(lane.laneId)
      if (skip) {
        outcome.skipped.push({ laneId: lane.laneId, reason: skip })
        continue
      }
      const stale = await this.probeLane(lane)
      if (stale) {
        outcome.skipped.push({ laneId: lane.laneId, reason: 'stale-probe' })
      } else {
        outcome.probed.push(lane.laneId)
      }
    }
    return outcome
  }

  /**
   * The two close-wipe preconditions plus the switch gate, all evaluated BEFORE a spawn.
   *
   * `absent` is checked as well as wipe-pending because a wipe that finished still leaves the
   * lane loadable, and the flag is read a moment too early by construction — §2f's post-sweep
   * read-back is the backstop, this is the fence.
   */
  private startSideRefusal(laneId: string): LaneUsageSkipReason | null {
    if (this.deps.isWipePending(laneId)) {
      return 'wipe-pending'
    }
    if (this.deps.laneStateOf(laneId) === 'absent') {
      return 'lane-absent'
    }
    return this.deps.isSwitchInProgress(laneId) ? 'switch-in-progress' : null
  }

  private async probeLane(lane: ClaudeLaneUsageAttribution): Promise<boolean> {
    const controller = new AbortController()
    const gateId = `lane-usage-probe:${lane.laneId}:${(this.deps.newGateId ?? randomUUID)()}`
    const controllers = this.inFlight.get(lane.laneId) ?? new Set<AbortController>()
    controllers.add(controller)
    this.inFlight.set(lane.laneId, controllers)
    this.deps.markProbeSpawned(gateId, lane.laneId)
    let usage: ProviderRateLimits | null = null
    try {
      usage = await this.deps.fetchUsage({
        authPreparation: buildLaneUsageAuthPreparation(lane),
        signal: controller.signal
      })
    } finally {
      // Release before the sync: the sync's own trigger reads the live-PTY set, and the probe
      // must not still be counted as the lane's live claude while it runs.
      this.deps.markProbeExited(gateId)
      controllers.delete(controller)
      if (controllers.size === 0) {
        this.inFlight.delete(lane.laneId)
      }
    }
    // A stale probe posts no usage row, emits no receipt and moves no watermark; the sync still
    // runs, because its own CLI may have rotated before the kill landed.
    const stale = controller.signal.aborted
    if (!stale && usage) {
      this.usageByLane.set(lane.laneId, usage)
    }
    await this.deps.syncProbedLane(lane.laneId)
    return stale
  }
}
