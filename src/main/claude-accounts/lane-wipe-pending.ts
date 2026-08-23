/**
 * `laneWipePending` — published by S9c's lane lifecycle, read by the lane usage pull (S9 §2f/§2k).
 *
 * It is the START-side half of the close-wipe fence. Killing what is in flight is only half of
 * it: without this flag the very next tick starts a probe into the lane it just watched being
 * wiped, and that probe's own `claude` can rotate and write `.credentials.json` back into a lane
 * the host has already reported wiped — `laneState: 'absent'` while a live credential sits at
 * rest.
 *
 * `principal-lane-lifecycle.ts` is the only writer: it marks before it aborts anything and clears
 * only on the post-sweep clean read-back. The marks are keyed by a per-wipe sequence because two
 * wipes can run on one lane — a revoke and a last-close fire independently — and an unkeyed clear
 * would let the first to finish open the second's fence mid-sweep.
 */
const wipePendingLaneIds = new Set<string>()
/** Per lane, the sequence ids of the wipes still running — two can overlap on one lane. */
const wipeSequencesInFlight = new Map<string, Set<number>>()
let nextWipeSequence = 1

/** S9c: set before the sweep aborts in-flight probes, not after it finishes. */
export function markLaneWipePending(laneId: string): number {
  wipePendingLaneIds.add(laneId)
  const sequence = nextWipeSequence
  nextWipeSequence += 1
  const inFlight = wipeSequencesInFlight.get(laneId) ?? new Set<number>()
  inFlight.add(sequence)
  wipeSequencesInFlight.set(laneId, inFlight)
  return sequence
}

/**
 * S9c: cleared only on §2f's clean post-sweep read-back, and only by the wipe that took the mark.
 *
 * A revoke and a last-close can both be wiping one lane — `removeLaneOnRevoke` and
 * `wipeLaneOnSocketClose` are fired independently — and an unkeyed clear would let the first to
 * finish drop the second's fence while it is still sweeping.
 */
export function clearLaneWipePending(laneId: string, sequence: number): void {
  releaseWipeSequence(laneId, sequence)
  if (!wipeSequencesInFlight.has(laneId)) {
    wipePendingLaneIds.delete(laneId)
  }
}

/** The sequence gave up without a clean read-back: the mark stays, the sequence does not. */
export function releaseUnconfirmedLaneWipe(laneId: string, sequence: number): void {
  releaseWipeSequence(laneId, sequence)
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
  if (isLaneWipeInFlight(laneId)) {
    return false
  }
  return wipePendingLaneIds.delete(laneId)
}

export function isLaneWipePending(laneId: string): boolean {
  return wipePendingLaneIds.has(laneId)
}

/** A sweep is running on this lane right now — the state a push must not write into (§2f). */
export function isLaneWipeInFlight(laneId: string): boolean {
  return wipeSequencesInFlight.has(laneId)
}

function releaseWipeSequence(laneId: string, sequence: number): void {
  const inFlight = wipeSequencesInFlight.get(laneId)
  if (!inFlight?.delete(sequence) || inFlight.size > 0) {
    return
  }
  wipeSequencesInFlight.delete(laneId)
}

/** Test seam only — production never clears the whole set. */
export function resetLaneWipePendingForTests(): void {
  wipePendingLaneIds.clear()
  wipeSequencesInFlight.clear()
}
