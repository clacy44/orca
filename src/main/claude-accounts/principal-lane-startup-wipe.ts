import {
  listResidentPrincipalLaneIds,
  type PrincipalLaneOptions
} from './principal-credential-lane'
import { PrincipalLaneLifecycle, type LaneWipeOutcome } from './principal-lane-lifecycle'
import { PrincipalLaneStore } from './principal-lane-store'

/**
 * The startup half of §2f, run BEFORE `seedLiveClaudePtysFromPersistence` and before the
 * listeners bind.
 *
 * A crash, a `kill` or an ordinary quit never runs the close handler, so a lane's
 * `.credentials.json` would otherwise stay resident with no grant connected. Rev 32 deletes the
 * watermark this pass used to record before wiping: with no push there is no desktop-asserted
 * `basedOn` claim left for a stale re-push to be judged against, so the observe step is gone and
 * the order simplifies to (1) the wipe, (2) the caller seeds the gate, (3) the caller binds
 * listeners.
 *
 * Deliberately coordinator-free: `ClaudeRuntimeAuthService` — and therefore the lane coordinator
 * it owns — is constructed later in startup, and nothing that coordinator owns exists yet either.
 * No usage probe can be in flight before the gate is seeded, so the fence's kill half has nothing
 * to kill.
 */
export async function wipeResidentLanesAtStartup(input: {
  laneOptions?: PrincipalLaneOptions
  /** Total budget across every lane: this pass is awaited in front of the app window. */
  budgetMs?: number
}): Promise<LaneWipeOutcome[]> {
  const laneOptions = input.laneOptions ?? {}
  const store = new PrincipalLaneStore(laneOptions)
  const lifecycle = new PrincipalLaneLifecycle({
    resolveLaneDir: (laneId) => store.resolveLaneDir(laneId),
    laneDirExists: (laneId) => store.hasLaneDirectory(laneId),
    // Nothing else runs against a lane this early, so the queue would only be a queue of one.
    serializeLaneWrite: (_laneId, run) => run(),
    invalidateProbes: () => Promise.resolve(),
    ...(laneOptions.platform ? { platform: laneOptions.platform } : {})
  })
  return lifecycle.wipeResidentLanesAtStartup(listResidentPrincipalLaneIds(laneOptions), {
    syncLaneObserveOnly: () => Promise.resolve(),
    ...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs })
  })
}
