// S10-21a C4 (Ruling 34 Addendum 9): incumbent-death signals for the Layer 2 rebind predicate
// (C5). Three independent proofs of a dead incumbent — D1 proven exit, D2 authoritative
// inventory absence, D3 settle interval — read from an evidence bundle the caller assembles.
// resolveIncumbentDeath itself is pure: no IO, no DB writes, no timers. The only IO (a live
// controller-inventory round) and the only mutable state (the settle-observation clock) live in
// OrcaRuntimeService.collectIncumbentEvidence and SettleObservations respectively, both of which
// this module also exports so C5 can be built the same way.
//
// The design's REBIND_SETTLE_MS did not exist anywhere in the repo before this commit (grepped
// clean across `git log --all`) — Ruling 34 Addendum 9 defines it here.
export const REBIND_SETTLE_MS = 10_000

export type IncumbentEvidence = {
  paneKey: string
  ptyId?: string
  /** D1 · proven exit. Absence from the runtime's live-pty map is NOT itself proof — a pty the
   * runtime never registered (e.g. a bad ptyId) must not read as "proven dead"; only an actually
   * observed exit event, in this runtime's current generation, counts. */
  d1: { ptyKnownToRuntime: boolean; exitObservedThisGeneration: boolean }
  /** D2 · authoritative inventory absence. 'unknown' covers a transient controller failure or a
   * superseded (non-current) round — it is NEVER treated as dead (§2.5: "a transient failure
   * returns null, never 'absent'"). */
  d2: { inventory: 'present' | 'absent' | 'unknown' }
  /** D3 · settle interval. `firstObservedNotLiveAt` is the first of two (or more) successive
   * not-live readings; dead only once `now` has advanced REBIND_SETTLE_MS past it. */
  d3: { liveNow: boolean; firstObservedNotLiveAt: number | null; now: number }
}

export type IncumbentVerdict =
  | { dead: true; signal: 'D1' | 'D2' | 'D3'; evidence: IncumbentEvidence }
  | { dead: false; reason: 'live' | 'inventory_unknown' | 'settling' | 'insufficient_evidence' }

/** Pure. Reads exactly the three signals §2.5 enumerates, in the priority order the design
 * states them (D1, then D2, then D3) — the first satisfied signal wins; a bundle can carry
 * corroborating evidence for more than one and this deliberately does not require agreement
 * between them, matching v3's "any one of" framing. No side effects, no DB writes, no timers. */
export function resolveIncumbentDeath(evidence: IncumbentEvidence): IncumbentVerdict {
  if (!evidence.d1.ptyKnownToRuntime && evidence.d1.exitObservedThisGeneration) {
    return { dead: true, signal: 'D1', evidence }
  }
  if (evidence.d2.inventory === 'absent') {
    return { dead: true, signal: 'D2', evidence }
  }
  if (
    !evidence.d3.liveNow &&
    evidence.d3.firstObservedNotLiveAt !== null &&
    evidence.d3.now - evidence.d3.firstObservedNotLiveAt >= REBIND_SETTLE_MS
  ) {
    return { dead: true, signal: 'D3', evidence }
  }
  if (evidence.d3.liveNow) {
    return { dead: false, reason: 'live' }
  }
  if (evidence.d2.inventory === 'unknown') {
    return { dead: false, reason: 'inventory_unknown' }
  }
  if (evidence.d3.firstObservedNotLiveAt !== null) {
    return { dead: false, reason: 'settling' }
  }
  return { dead: false, reason: 'insufficient_evidence' }
}

/** Host-only, in-memory clock for D3's settle window: the first time a pane was observed
 * not-live, cleared the moment it is observed live again. No timers — the caller supplies `now`
 * on every observation, so this is exactly as pure as a plain Map with a "first seen" rule. */
export class SettleObservations {
  private readonly firstNotLiveAtByPaneKey = new Map<string, number>()

  observe(paneKey: string, liveNow: boolean, now: number): void {
    if (liveNow) {
      this.firstNotLiveAtByPaneKey.delete(paneKey)
      return
    }
    if (!this.firstNotLiveAtByPaneKey.has(paneKey)) {
      this.firstNotLiveAtByPaneKey.set(paneKey, now)
    }
  }

  firstNotLiveAt(paneKey: string): number | null {
    return this.firstNotLiveAtByPaneKey.get(paneKey) ?? null
  }

  forget(paneKey: string): void {
    this.firstNotLiveAtByPaneKey.delete(paneKey)
  }
}
