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

/** S9c: set before the sweep aborts in-flight probes, not after it finishes. */
export function markLaneWipePending(laneId: string): void {
  wipePendingLaneIds.add(laneId)
}

/** S9c: cleared only on §2f's clean post-sweep read-back. */
export function clearLaneWipePending(laneId: string): void {
  wipePendingLaneIds.delete(laneId)
}

export function isLaneWipePending(laneId: string): boolean {
  return wipePendingLaneIds.has(laneId)
}

/** Test seam only — production never clears the whole set. */
export function resetLaneWipePendingForTests(): void {
  wipePendingLaneIds.clear()
}
