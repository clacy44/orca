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
  /** Lanes whose probe threw. Isolated: the tick goes on, and the lane is still synced. */
  failed: string[]
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

/** One probe the module can still reach: its abort handle, and when its `claude` is gone. */
type InFlightProbe = { controller: AbortController; settled: Promise<void> }

export class LaneUsagePull {
  private readonly inFlight = new Map<string, Set<InFlightProbe>>()
  private readonly usageByLane = new Map<string, ProviderRateLimits>()
  private running: Promise<LaneUsagePullOutcome> | null = null

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

  /**
   * A push or a close-wipe marks every probe in flight in that lane stale and kills it (§2f/§2k).
   *
   * Awaited to the probe's own settlement, which is where `fetchViaPty`'s abort path has already
   * run `cleanupHiddenRateLimitPty(…, { kill: true })`: the caller is about to replace or sweep
   * `.credentials.json`, and a `claude` still holding the PRE-push single-use refresh token would
   * post usage for the old account and rotate a credential the lane no longer holds. It does NOT
   * wait for the probe's post-probe `syncLane`, which takes the lane write queue the caller holds.
   */
  async invalidateLane(laneId: string): Promise<void> {
    const probes = [...(this.inFlight.get(laneId) ?? [])]
    for (const probe of probes) {
      probe.controller.abort()
    }
    await Promise.all(probes.map((probe) => probe.settled))
  }

  /**
   * One tick at a time (§2k's budget is `N` hidden `claude` processes per tick, not `2N`).
   *
   * `claudeAuthPreparationResolver` is awaited twice per rate-limit cycle — once to capture the
   * pre-fetch preparation and once to detect a switch that happened during the fetch — and both
   * reads reach `prepareForRateLimitFetch`. Without this the second read spawns a second round of
   * probes, doubling the hidden processes and deferring each lane's rotation twice.
   */
  run(): Promise<LaneUsagePullOutcome> {
    if (!this.running) {
      this.running = this.runTick().finally(() => {
        this.running = null
      })
    }
    return this.running
  }

  private async runTick(): Promise<LaneUsagePullOutcome> {
    const outcome: LaneUsagePullOutcome = {
      probed: [],
      skipped: [],
      failed: [],
      disabled: this.isDisabled()
    }
    if (outcome.disabled) {
      return outcome
    }
    for (const lane of this.deps.listLoadedLanes()) {
      const skip = this.startSideRefusal(lane.laneId)
      if (skip) {
        outcome.skipped.push({ laneId: lane.laneId, reason: skip })
        continue
      }
      // `probeLane` is total by construction — see its own guards. A rejection here would skip
      // every LATER lane and reject the caller, which is the rate-limit cycle's first await.
      const result = await this.probeLane(lane)
      if (result === 'stale') {
        outcome.skipped.push({ laneId: lane.laneId, reason: 'stale-probe' })
      } else if (result === 'failed') {
        outcome.failed.push(lane.laneId)
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

  /** Total: every await inside is guarded, so one lane's failure cannot end the tick. */
  private async probeLane(
    lane: ClaudeLaneUsageAttribution
  ): Promise<'probed' | 'stale' | 'failed'> {
    const controller = new AbortController()
    const gateId = `lane-usage-probe:${lane.laneId}:${(this.deps.newGateId ?? randomUUID)()}`
    let markSettled = (): void => {}
    const probe: InFlightProbe = {
      controller,
      settled: new Promise<void>((resolve) => {
        markSettled = resolve
      })
    }
    const probes = this.inFlight.get(lane.laneId) ?? new Set<InFlightProbe>()
    probes.add(probe)
    this.inFlight.set(lane.laneId, probes)
    this.deps.markProbeSpawned(gateId, lane.laneId)
    let usage: ProviderRateLimits | null = null
    let failed = false
    try {
      usage = await this.deps.fetchUsage({
        authPreparation: buildLaneUsageAuthPreparation(lane),
        signal: controller.signal
      })
    } catch (error) {
      // Why caught rather than propagated: `pty.spawn` is unguarded inside the fetch's executor,
      // so a missing `claude`, a bad cwd or a node-pty failure rejects here. Unhandled, that
      // would skip the post-probe sync — the very watermark move §2c trigger 2's second arm
      // exists for — and reject the whole rate-limit cycle in front of every other provider.
      failed = true
      console.warn('[lane-usage-pull] lane usage probe failed:', error)
    } finally {
      // Release before the sync: the sync's own trigger reads the live-PTY set, and the probe
      // must not still be counted as the lane's live claude while it runs.
      this.deps.markProbeExited(gateId)
      probes.delete(probe)
      if (probes.size === 0) {
        this.inFlight.delete(lane.laneId)
      }
      markSettled()
    }
    // A stale probe posts no usage row, emits no receipt and moves no watermark; the sync still
    // runs, because its own CLI may have rotated before the kill landed — and so does a FAILED
    // one, which may have rotated before it threw.
    const stale = controller.signal.aborted
    if (!stale && !failed && usage) {
      this.usageByLane.set(lane.laneId, usage)
    }
    try {
      await this.deps.syncProbedLane(lane.laneId)
    } catch (error) {
      console.warn('[lane-usage-pull] post-probe lane sync failed:', error)
    }
    if (failed) {
      return 'failed'
    }
    return stale ? 'stale' : 'probed'
  }
}
