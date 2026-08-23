import {
  listResidentPrincipalLaneIds,
  type PrincipalLaneOptions
} from './principal-credential-lane'
import { PrincipalLaneLifecycle, type LaneWipeOutcome } from './principal-lane-lifecycle'
import { PrincipalLaneStore, type LaneWatermarkPersistence } from './principal-lane-store'

/**
 * The startup half of §2f, run BEFORE `seedLiveClaudePtysFromPersistence` and before the
 * listeners bind.
 *
 * A crash, a `kill` or an ordinary quit never runs the close handler, so a lane's
 * `.credentials.json` would otherwise stay resident with no grant connected. The order is fixed
 * and each step exists for a different failure: (1) an OBSERVE-ONLY read of each resident lane
 * that records the watermark — trigger 4 must not rotate, because a daemon-hosted `claude` that
 * survived the restart still holds the single-use refresh token and the live-PTY gate is empty by
 * construction at this instant; (2) the wipe; (3) the caller seeds the gate; (4) the caller binds
 * listeners. Watermarking first is what refuses the reconnecting desktop's cached pre-restart blob
 * (`accounts.lane.push_stale`) even though the lane it is pushed into is now empty.
 *
 * Deliberately coordinator-free: `ClaudeRuntimeAuthService` — and therefore the lane coordinator
 * it owns — is constructed later in startup, and nothing that coordinator owns exists yet either.
 * No usage probe can be in flight before the gate is seeded, so the fence's kill half has nothing
 * to kill and the residency index has no row to clear.
 */
export async function wipeResidentLanesAtStartup(input: {
  persistence: LaneWatermarkPersistence
  laneOptions?: PrincipalLaneOptions
}): Promise<LaneWipeOutcome[]> {
  const laneOptions = input.laneOptions ?? {}
  const store = new PrincipalLaneStore(input.persistence, laneOptions)
  const lifecycle = new PrincipalLaneLifecycle({
    resolveLaneDir: (laneId) => store.resolveLaneDir(laneId),
    // Nothing else runs against a lane this early, so the queue would only be a queue of one.
    serializeLaneWrite: (_laneId, run) => run(),
    invalidateProbes: () => Promise.resolve(),
    clearResidencyRow: () => {},
    removeWatermark: (laneId) => store.removeWatermark(laneId),
    syncLaneObserveOnly: (laneId) => Promise.resolve(recordStartupWatermark(store, laneId)),
    ...(laneOptions.platform ? { platform: laneOptions.platform } : {})
  })
  return lifecycle.wipeResidentLanesAtStartup(listResidentPrincipalLaneIds(laneOptions))
}

/** Writer 1 with no rotation arm: what the lane holds right now, and nothing else. */
function recordStartupWatermark(store: PrincipalLaneStore, laneId: string): void {
  const credentialsJson = store.readLaneCredentials(laneId)
  if (credentialsJson === null) {
    return
  }
  store.recordSyncedLaneCredentials(laneId, credentialsJson, store.readLaneOauthAccount(laneId))
}
