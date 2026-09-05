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
import type { AgentAliveResult } from './orchestration/agent-process-identity'

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
  /** [S10-21a C7h, Ruling 34 Addendum 26] Liveness over the SAME controller-inventory round
   * already fetched for `ptyId` above — never a second daemon round-trip. Optional: pure
   * fixtures (resolveIncumbentDeath's own tests) never read it. */
  ptyLive?: (ptyId: string) => boolean
  /** [S10-21a C7i, Ruling 34 Addendum 27] Same round as `ptyLive`, three-valued: 'unknown' iff
   * the round is null. `ptyLive(id) === (ptyState(id) === 'present')`. */
  ptyState?: (ptyId: string) => 'present' | 'absent' | 'unknown'
  /** [S10-21a C7i, Ruling 34 Addendum 27] The round's identified handle+incarnation for a ptyId,
   * when the controller could positively identify it — same round as `ptyLive`/`ptyState`. */
  terminalIdentity?: (ptyId: string) => { handle: string; incarnationId: string } | undefined
  /** [S10-21a C7k, Ruling 34 Addendum 28, D-R118] Whether the runtime has THIS ptyId connected
   * right NOW, independent of the (possibly older) shared round `ptyState` reads — the union of
   * the two is the occupant-liveness signal the sweep routes rows 8-11 on (a pty created after
   * the round was taken must never read as absent). Optional: pure fixtures never read it. */
  ptyConnectedNow?: (ptyId: string) => boolean
  /** [S10-21a C7k, Ruling 34 Addendum 28, D-R118] The agent's OWN process-identity verdict
   * (`agentAlive`, agent-process-identity.ts), set by the sweep from the SAME shared inventory
   * round — when present, it dominates D1/D2/D3 entirely: a 'dead' verdict is dead regardless of
   * what the d1/d2/d3 fields say (a reused ptyId under another incarnation must never read
   * 'insufficient_evidence'/'live' and refuse the rebind as `incumbent_alive`), and an 'alive'
   * verdict is never dead. Absent (or an 'unknown_*' verdict) falls through to D1/D2/D3 as before. */
  agentIdentity?: { verdict: AgentAliveResult; ptyId: string; incarnationId: string }
}

export type IncumbentVerdict =
  | { dead: true; signal: 'D1' | 'D2' | 'D3' | 'IDENTITY'; evidence: IncumbentEvidence }
  | {
      dead: false
      reason:
        | 'live'
        | 'inventory_unknown'
        | 'settling'
        | 'insufficient_evidence'
        | 'conflicting_signals'
        | 'IDENTITY_ALIVE'
    }

/** Pure. Reads exactly the three signals §2.5 enumerates — a live reading outranks every death
 * signal (Ruling 34 Addendum 10): if D3 currently reads live, D1/D2 death evidence is reported
 * as a conflict rather than accepted, and only a genuinely all-alive bundle reads plain 'live'.
 * Otherwise D1, then D2, then D3 are checked in the priority order the design states them; a
 * bundle can carry corroborating evidence for more than one and this deliberately does not
 * require agreement between them, matching v3's "any one of" framing. No side effects, no DB
 * writes, no timers. */
export function resolveIncumbentDeath(evidence: IncumbentEvidence): IncumbentVerdict {
  // [S10-21a C7k, Ruling 34 Addendum 28] The identity verdict dominates — checked BEFORE any
  // D1/D2/D3 reasoning, including the D3-live conflict check below. An 'unknown_*' verdict (or
  // no `agentIdentity` at all) falls through unchanged.
  if (evidence.agentIdentity) {
    if (evidence.agentIdentity.verdict === 'dead') {
      return { dead: true, signal: 'IDENTITY', evidence }
    }
    if (evidence.agentIdentity.verdict === 'alive') {
      return { dead: false, reason: 'IDENTITY_ALIVE' }
    }
  }
  const d1Dead = !evidence.d1.ptyKnownToRuntime && evidence.d1.exitObservedThisGeneration
  const d2Dead = evidence.d2.inventory === 'absent'
  if (evidence.d3.liveNow) {
    if (d1Dead || d2Dead) {
      return { dead: false, reason: 'conflicting_signals' }
    }
    return { dead: false, reason: 'live' }
  }
  if (d1Dead) {
    return { dead: true, signal: 'D1', evidence }
  }
  if (d2Dead) {
    return { dead: true, signal: 'D2', evidence }
  }
  if (
    evidence.d3.firstObservedNotLiveAt !== null &&
    evidence.d3.now - evidence.d3.firstObservedNotLiveAt >= REBIND_SETTLE_MS
  ) {
    return { dead: true, signal: 'D3', evidence }
  }
  if (evidence.d2.inventory === 'unknown') {
    return { dead: false, reason: 'inventory_unknown' }
  }
  if (evidence.d3.firstObservedNotLiveAt !== null) {
    return { dead: false, reason: 'settling' }
  }
  return { dead: false, reason: 'insufficient_evidence' }
}

/** F1 (Ruling 34 Addendum 10): bound on the settle map's live pane-key count. A runtime that
 * churns through many panes over a long lifetime must not grow this map unbounded; the oldest
 * insertion (Map insertion order) is evicted first once the cap is exceeded. */
export const SETTLE_OBSERVATIONS_CAP = 4096

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
      if (this.firstNotLiveAtByPaneKey.size > SETTLE_OBSERVATIONS_CAP) {
        const oldestKey = this.firstNotLiveAtByPaneKey.keys().next().value
        if (oldestKey !== undefined) {
          this.firstNotLiveAtByPaneKey.delete(oldestKey)
        }
      }
    }
  }

  firstNotLiveAt(paneKey: string): number | null {
    return this.firstNotLiveAtByPaneKey.get(paneKey) ?? null
  }

  forget(paneKey: string): void {
    this.firstNotLiveAtByPaneKey.delete(paneKey)
  }
}
