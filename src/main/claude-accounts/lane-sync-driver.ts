import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import type { LaneAuthState } from './lane-auth-state'
import type { LaneCredentialState, PrincipalLaneStore } from './principal-lane-store'

/**
 * The lane identity resolver (S9 §2c, rev 32's credential-source re-basing, §6's S9-L3).
 *
 * Through rev 31 this class also rotated a lane's credential and recorded a persisted watermark
 * to detect the lane's own CLI moving the token behind Orca's back. Rev 32 deletes both: the lane
 * holds its own OAuth grant and rotates its own chain, so Orca never rotates it (§2e), and with no
 * push there is no desktop-asserted state left to reconcile a watermark against. What remains is a
 * live read of what the lane's file currently holds, still taken under the lane's write queue so
 * it never straddles an in-flight write.
 */
export type LaneSyncTrigger =
  /** Before a lane-pinned launch — the lane arm of `prepareForClaudeLaunch`. */
  | 'launch'
  /** Each rate-limit tick for a lane with live PTYs, and each lane the usage pull probed. */
  | 'rate-limit-tick'

export type LaneSyncOutcome = {
  laneId: string
  trigger: LaneSyncTrigger
  laneState: RuntimeTerminalLaneState
  credentialState: LaneCredentialState | null
}

export type LaneSyncDriverOptions = {
  store: PrincipalLaneStore
  authState: LaneAuthState
}

export class LaneSyncDriver {
  constructor(private readonly options: LaneSyncDriverOptions) {}

  syncLane(laneId: string, trigger: LaneSyncTrigger): Promise<LaneSyncOutcome> {
    return this.options.authState.serializeLaneWrite(laneId, async () =>
      this.doSyncLane(laneId, trigger)
    )
  }

  private doSyncLane(laneId: string, trigger: LaneSyncTrigger): LaneSyncOutcome {
    const { store } = this.options
    return {
      laneId,
      trigger,
      laneState: store.getLaneState(laneId),
      credentialState: store.getCredentialState(laneId)
    }
  }
}
