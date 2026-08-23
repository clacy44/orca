/**
 * `laneWipePending` — published by S9c's lane lifecycle, read by the lane usage pull (S9 §2f/§2k).
 *
 * It is the START-side half of the close-wipe fence. Killing what is in flight is only half of
 * it: without this flag the very next tick starts a probe into the lane it just watched being
 * wiped, and that probe's own `claude` can rotate and write `.credentials.json` back into a lane
 * the host has already reported wiped — `laneState: 'absent'` while a live credential sits at
 * rest.
 *
 * The writers are declared here and left unwired: S9c's `principal-lane-lifecycle.ts` is what
 * marks and clears a wipe, and until it lands nothing in production calls them. The reader is
 * wired now, so the fence is complete the moment the lifecycle arrives rather than being
 * retrofitted onto a pull that has already shipped without it.
 */
const wipePendingLaneIds = new Set<string>()
const wipesInFlightLaneIds = new Set<string>()

/** S9c: set before the sweep aborts in-flight probes, not after it finishes. */
export function markLaneWipePending(laneId: string): void {
  wipePendingLaneIds.add(laneId)
  wipesInFlightLaneIds.add(laneId)
}

/** S9c: cleared only on §2f's clean post-sweep read-back. */
export function clearLaneWipePending(laneId: string): void {
  wipePendingLaneIds.delete(laneId)
  wipesInFlightLaneIds.delete(laneId)
}

/** The sequence gave up without a clean read-back: the mark stays, the sequence does not. */
export function releaseUnconfirmedLaneWipe(laneId: string): void {
  wipesInFlightLaneIds.delete(laneId)
}

/**
 * A credential deliberately loaded into the lane voids an UNCONFIRMED wipe's mark.
 *
 * Without this the mark is a one-way latch: one Keychain error or one probe that never confirmed
 * dead would skip that lane's usage probe and publish `laneWipePending` over a demonstrably
 * loaded lane for the rest of the process. A wipe still IN FLIGHT wins — it is about to sweep
 * whatever is there, and its fence must not be opened underneath it.
 */
export function clearLaneWipePendingOnCredentialLoaded(laneId: string): boolean {
  if (wipesInFlightLaneIds.has(laneId)) {
    return false
  }
  return wipePendingLaneIds.delete(laneId)
}

export function isLaneWipePending(laneId: string): boolean {
  return wipePendingLaneIds.has(laneId)
}

/** Test seam only — production never clears the whole set. */
export function resetLaneWipePendingForTests(): void {
  wipePendingLaneIds.clear()
  wipesInFlightLaneIds.clear()
}
