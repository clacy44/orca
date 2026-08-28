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
 * S9-L1 §fenceWiring "THE LATCH RELEASE", the bounded-budget arm: after a sweep attempt loop
 * exhausts its OWN retry budget (confirm-dead-window × `LANE_SWEEP_PASSES`, `WIPE_ATTEMPTS` in
 * `principal-lane-lifecycle.ts`) with no clean read-back, the MARK releases too — not only the
 * sequence. Distinct from `releaseUnconfirmedLaneWipe`: a caller that never attempted a sweep at
 * all (`refuseWipe` — it could not even prove ownership of the lane directory) has no sweep
 * budget to have exhausted, and must keep using that one to leave the mark latched.
 *
 * Returns whether the mark actually cleared — false when ANOTHER sequence is still in flight on
 * this lane (a second wipe racing this one), whose own give-up or success owns the mark; clearing
 * it here would race that sequence's own transition.
 */
export function releaseUnconfirmedLaneWipeBudgetExhausted(
  laneId: string,
  sequence: number
): boolean {
  releaseWipeSequence(laneId, sequence)
  if (wipeSequencesInFlight.has(laneId)) {
    return false
  }
  return wipePendingLaneIds.delete(laneId)
}

/**
 * `orca lane wipe --person <name> --force` (S9-L1 §fenceWiring "THE LATCH RELEASE"): the exit a
 * fence-with-no-exit needs once S9-L3 deletes `applyPush`'s `clearLaneWipePendingOnCredentialLoaded`
 * un-latching path (`lane-wire-authority.ts` no longer calls it — rev 32 already deleted `applyPush`
 * itself in this tree). Without SOME exit, a lane a wipe could never confirm dead stays
 * wipe-pending — and therefore un-loginnable AND un-launchable — for the rest of the process.
 *
 * Deliberately an OPERATOR action, not a timer: a stale, unconfirmed-dead credential may still be
 * at rest under this mark (`principal-lane-lifecycle.ts`'s give-up arms never run the sweep), and
 * `getLaneState` reads this same mark to keep a launch failing closed. An automatic release on the
 * ordinary confirm-dead budget would silently make that credential launchable again the moment the
 * budget expired — the informed human judgment call `--force` requires is what makes that
 * acceptable instead of a silent regression.
 *
 * Refuses to act while a sequence is genuinely IN FLIGHT on this lane — a wipe actively mid-sweep
 * must not have its own fence opened underneath it by an operator racing it from another shell.
 */
export function forceReleaseLaneWipeLatch(laneId: string): boolean {
  if (isLaneWipeInFlight(laneId)) {
    return false
  }
  return wipePendingLaneIds.delete(laneId)
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
