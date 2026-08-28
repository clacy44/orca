import type { ClaudeLaneUsageAttribution } from '../rate-limits/claude-usage-attribution'
import { fetchViaPty } from '../rate-limits/claude-pty'
import {
  LaneUsagePull,
  type LaneUsagePullDeps,
  type LaneUsagePullOutcome
} from '../rate-limits/lane-usage-pull'
import { isLaneWipePending } from './lane-wipe-pending'
import { PrincipalLaneLifecycle } from './principal-lane-lifecycle'
import {
  isClaudeAuthSwitchInProgress,
  listLanesWithLiveClaudePtys,
  markEphemeralClaudePtyExited,
  markEphemeralClaudePtySpawned
} from './live-pty-gate'
import { ensureLaneProvenanceLabelOrNull, formatLaneProvenance } from './principal-lane-provenance'
import { LaneAuthState } from './lane-auth-state'
import { LaneLoginSessionRegistry } from './lane-login-session'
import { LaneSyncDriver, type LaneSyncOutcome, type LaneSyncTrigger } from './lane-sync-driver'
import { PrincipalLaneStore } from './principal-lane-store'
import type { PrincipalLaneOptions } from './principal-credential-lane'
import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

/**
 * The one host-side owner of the lane credential machinery (S9 §2c/§2e, rev 32).
 *
 * `ClaudeRuntimeAuthService` holds one of these and takes only delegating calls on it, so the
 * lane store, the (lane, account) auth state and the sync driver stay wired together in exactly
 * one place rather than being re-composed per call site. Rev 32 deletes the residency index with
 * L1: two lanes, or a lane and the desktop, now hold independent grants that cannot rotate one
 * another's chain, so there is nothing left to hold a residency row FOR.
 */
export type LaneCredentialCoordinatorOptions = {
  laneOptions?: PrincipalLaneOptions
  /** Injected so the tick arm is observable without the module-global pty gate. */
  listLanesWithLivePtys?: () => string[]
  /** Injected so the probe's fence is assertable without spawning a real hidden `claude`. */
  fetchLaneUsage?: LaneUsagePullDeps['fetchUsage']
  /** Injected so a login session's CLI version gate is assertable without depending on whichever
   *  `claude` build happens to be installed on the box the suite runs on. */
  assertLoginCliVersionSupported?: () => void
}

export class LaneCredentialCoordinator {
  readonly store: PrincipalLaneStore
  readonly authState: LaneAuthState
  readonly syncDriver: LaneSyncDriver
  readonly usagePull: LaneUsagePull
  readonly lifecycle: PrincipalLaneLifecycle
  /** S9-L1: the per-lane login session map, sharing this coordinator's own write queue. */
  readonly loginSessions: LaneLoginSessionRegistry
  private laneUsageInvalidated: ((laneId: string) => void) | null = null
  private laneWiped: ((laneId: string) => void) | null = null
  // Why populated from `syncLane` rather than from a lane listing: "loaded" is a fact the sync
  // establishes, and a lane that has never synced has no row to attribute usage to (S9 §2k).
  private readonly usageAttributions = new Map<string, ClaudeLaneUsageAttribution>()

  constructor(private readonly options: LaneCredentialCoordinatorOptions) {
    this.store = new PrincipalLaneStore(options.laneOptions ?? {})
    this.authState = new LaneAuthState()
    this.syncDriver = new LaneSyncDriver({
      store: this.store,
      authState: this.authState
    })
    this.usagePull = new LaneUsagePull({
      listLoadedLanes: () => this.laneUsageAttributions(),
      laneStateOf: (laneId) => this.store.getLaneState(laneId),
      isWipePending: isLaneWipePending,
      isSwitchInProgress: (laneId) => isClaudeAuthSwitchInProgress(laneId),
      fetchUsage: options.fetchLaneUsage ?? ((input) => fetchViaPty(input)),
      markProbeSpawned: markEphemeralClaudePtySpawned,
      markProbeExited: markEphemeralClaudePtyExited,
      syncProbedLane: async (laneId) => {
        await this.syncLane(laneId, 'rate-limit-tick')
      }
    })
    this.loginSessions = new LaneLoginSessionRegistry({
      authState: this.authState,
      ...(options.assertLoginCliVersionSupported
        ? { assertCliVersionSupported: options.assertLoginCliVersionSupported }
        : {})
    })
    this.lifecycle = new PrincipalLaneLifecycle({
      resolveLaneDir: (laneId) => this.store.resolveLaneDir(laneId),
      laneDirExists: (laneId) => this.store.hasLaneDirectory(laneId),
      serializeLaneWrite: (laneId, run) => this.authState.serializeLaneWrite(laneId, run),
      invalidateProbes: (laneId) => this.invalidateLaneUsageProbes(laneId),
      cancelLaneLoginSessions: (laneId) => this.loginSessions.cancelLaneLoginSessions(laneId),
      sweepCancelledLoginDirs: (laneId) => this.loginSessions.sweepCancelledLoginDirs(laneId),
      ...(options.laneOptions?.platform ? { platform: options.laneOptions.platform } : {}),
      onLaneWiped: (laneId) => this.laneWiped?.(laneId)
    })
  }

  /** Late-bound: the lane wire that republishes a lane's status outlives this constructor. */
  setLaneWipedListener(listener: ((laneId: string) => void) | null): void {
    this.laneWiped = listener
  }

  /** Trigger 2's SECOND arm: one probe per loaded lane, then a sync over each lane probed. */
  pullLaneUsage(): Promise<LaneUsagePullOutcome> {
    return this.usagePull.run()
  }

  /**
   * The same tick, NOT awaited — the pull must not sit on the rate-limit cycle's critical path.
   *
   * Each probe is a real hidden `claude` bounded by a 25 s PTY timeout and the lanes are probed in
   * series, so awaiting it would put up to `N × 25 s` in front of the codex/gemini/kimi/minimax/
   * grok dispatch, none of which has anything to do with a lane. The pull re-entrancy guard
   * collapses the cycle's two resolver reads into one tick.
   */
  startLaneUsagePull(): void {
    void this.pullLaneUsage().catch((error: unknown) => {
      console.warn('[lane-usage-pull] lane usage tick failed:', error)
    })
  }

  /** The usage row a terminal's lane join reads; null while the pull is disabled or unrun. */
  laneUsage(laneId: string): ProviderRateLimits | null {
    return this.usagePull.laneUsage(laneId)
  }

  /**
   * The kill half of §2f/§2k's fence: a push or a wipe invalidates this lane's probes first.
   *
   * Awaited, so the caller replaces or sweeps `.credentials.json` only once the `claude` holding
   * the pre-change token is gone.
   */
  async invalidateLaneUsageProbes(laneId: string): Promise<void> {
    await this.usagePull.invalidateLane(laneId)
    // BOTH feeds, not just the probe's: the statusline row was posted by the session the change
    // is displacing, and on `win32` — where no probe runs at all — it is the only feed there is.
    this.laneUsageInvalidated?.(laneId)
  }

  /** Late-bound: the rate-limit service that owns the statusline sink outlives this constructor. */
  setLaneUsageInvalidationListener(listener: ((laneId: string) => void) | null): void {
    this.laneUsageInvalidated = listener
  }

  /** True where no probe can run (§2k Fact 2): the row says why rather than showing no bar. */
  isLaneUsagePullDisabled(): boolean {
    return this.usagePull.isDisabled()
  }

  async syncLane(laneId: string, trigger: LaneSyncTrigger): Promise<LaneSyncOutcome> {
    const outcome = await this.syncDriver.syncLane(laneId, trigger)
    this.recordUsageAttribution(laneId, outcome.laneState)
    return outcome
  }

  /** One entry per LOADED lane, for the statusline attribution map (S9 §2k). */
  laneUsageAttributions(): ClaudeLaneUsageAttribution[] {
    return [...this.usageAttributions.values()]
  }

  private recordUsageAttribution(laneId: string, laneState: RuntimeTerminalLaneState): void {
    const laneDir = laneState === 'loaded' ? this.store.resolveLaneDir(laneId) : null
    if (!laneDir) {
      // Why dropped rather than kept stale: a wiped or reauth-held lane must stop attracting
      // posts, and §2d omits a peer's lane usage rather than showing a stale bar.
      this.usageAttributions.delete(laneId)
      return
    }
    // Why nullable and not thrown: minting the label is a WRITE, and this runs after the sync has
    // already succeeded — a swept lane dir must not turn that success into a rejection.
    const label = ensureLaneProvenanceLabelOrNull(laneDir)
    if (!label) {
      this.usageAttributions.delete(laneId)
      return
    }
    this.usageAttributions.set(laneId, {
      laneId,
      configDir: laneDir,
      // Why the opaque label and not the lane path: `provenance` is published on the usage row.
      provenance: formatLaneProvenance(label)
    })
  }

  /**
   * Trigger 2's FIRST arm: every lane a live `claude` is running in, at each rate-limit tick.
   *
   * Its own CLI may have rotated the single-use token since the last tick, and a lane whose
   * writer "does nothing else" would never see it. The second arm — one sync per lane the usage
   * pull PROBED, whether or not that lane still has live PTYs — is evaluated after the probe
   * exits and belongs to the per-lane usage pull, not here.
   */
  async syncLanesWithLivePtys(): Promise<LaneSyncOutcome[]> {
    const listLanes = this.options.listLanesWithLivePtys ?? listLanesWithLiveClaudePtys
    const outcomes: LaneSyncOutcome[] = []
    for (const laneId of listLanes()) {
      outcomes.push(await this.syncLane(laneId, 'rate-limit-tick'))
    }
    return outcomes
  }
}
