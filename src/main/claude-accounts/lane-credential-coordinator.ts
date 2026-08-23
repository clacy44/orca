import { AccountResidencyIndex, type SharedLaneCredentialReader } from './account-residency-index'
import { LaneAuthState } from './lane-auth-state'
import { LaneSyncDriver, type LaneSyncOutcome, type LaneSyncTrigger } from './lane-sync-driver'
import { PrincipalLaneStore, type LaneWatermarkPersistence } from './principal-lane-store'
import type { PrincipalLaneOptions } from './principal-credential-lane'

/**
 * The one host-side owner of the lane credential machinery (S9 §2c/§2e).
 *
 * `ClaudeRuntimeAuthService` holds one of these and takes only delegating calls on it, so the
 * lane store, the residency index, the (lane, account) auth state and the sync driver stay wired
 * together in exactly one place rather than being re-composed per call site.
 */
export type LaneCredentialCoordinatorOptions = {
  persistence: LaneWatermarkPersistence
  sharedLane: SharedLaneCredentialReader
  resolvePresenceLabel?: (laneId: string) => string | null
  laneOptions?: PrincipalLaneOptions
}

export class LaneCredentialCoordinator {
  readonly store: PrincipalLaneStore
  readonly residency: AccountResidencyIndex
  readonly authState: LaneAuthState
  readonly syncDriver: LaneSyncDriver

  constructor(options: LaneCredentialCoordinatorOptions) {
    this.store = new PrincipalLaneStore(options.persistence, options.laneOptions ?? {})
    this.residency = new AccountResidencyIndex({
      sharedLane: options.sharedLane,
      resolvePresenceLabel: options.resolvePresenceLabel
    })
    this.authState = new LaneAuthState({ store: this.store, residency: this.residency })
    this.syncDriver = new LaneSyncDriver({
      store: this.store,
      residency: this.residency,
      authState: this.authState
    })
  }

  syncLane(laneId: string, trigger: LaneSyncTrigger): Promise<LaneSyncOutcome> {
    return this.syncDriver.syncLane(laneId, trigger)
  }

  /** Called from the shared lane's own sync so the `host` residency row never goes stale. */
  refreshHostResidencyRow(): void {
    this.residency.refreshHostRow()
  }

  /**
   * The lane arm of `managedRefreshDeferredByLivePty`: account-scoped, not host-global.
   *
   * A lane with no residency row yet answers from the unattributed-pty arm inside the auth state,
   * which is the safe direction.
   */
  isLaneRefreshDeferredByLivePty(laneId: string): boolean {
    return this.authState.isRefreshDeferredByLivePty(
      this.residency.getLaneRowKeys(laneId) ?? { accountUuid: null, refreshTokenSha256: null }
    )
  }
}
