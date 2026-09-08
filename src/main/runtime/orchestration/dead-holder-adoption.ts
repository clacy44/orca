// S10-21d b3 (design-r104-framing-B-attacker.md HOST_ADOPT conjuncts; s10-21d-design-v1
// DEC-3): the launcher-issued restore's dead-holder-adoption predicate. Pure — no IO, no DB, no
// timers; the caller (requestChairRestore) gathers every input via the existing accessors
// (collectIncumbentEvidence/resolveIncumbentDeath, findConnectedPtyForPane, newestLaunchForPane,
// isRestoreSweepLockHeld + getSweepRestoreMark, the hook server's live provider-session set,
// S4's preflightResumeTranscript) and re-reads them inside the pane lock before calling this.
//
// Conjuncts A-G exactly, checked in order — the first false conjunct is the refusal. GEN_ABSENCE
// (D's second admissible signal) additionally requires D2 absence over a NON-NULL inventory
// round, no connected pty on the holder pane, and no live hook report of the session from any
// pane — D3 (settle) never suffices on its own, matching framing B attack 1's block.
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { IncumbentVerdict } from '../incumbent-death'

export type HolderAdoptionRefusalReason =
  | 'same_pane'
  | 'cross_execution_host'
  | 'current_generation'
  | 'holder_launch_row_missing'
  | 'death_signal_insufficient'
  | 'sweep_in_flight'
  | 'other_live_registered_row'
  | 'transcript_preflight_failed'

export type HolderAdoptionInput = {
  /** The pane currently named as X's holder in current_sessions. */
  holderPaneKey: string
  /** The pane the launcher is opening (this restore's own new pane). */
  adoptingPaneKey: string
  holderExecutionHostId: string
  adoptingExecutionHostId: string
  /** The holder's newest agent_launch_sessions row's launch_generation — null when the holder
   * pane has no launch row at all (a data inconsistency: current_sessions named a pane with no
   * backing row), refused rather than guessed. */
  holderLaunchGeneration: string | null
  currentLaunchGeneration: string
  /** resolveIncumbentDeath's own verdict over the holder, re-read inside the pane lock. */
  incumbent: IncumbentVerdict
  /** D2's own three-valued inventory read for the holder's ptyId, over the SAME round as
   * `inventoryRoundNonNull`. */
  d2Inventory: 'present' | 'absent' | 'unknown'
  inventoryRoundNonNull: boolean
  holderHasConnectedPty: boolean
  /** True iff the hook server's live provider-session set names session X on ANY pane. */
  liveHookReportOfSessionElsewhere: boolean
  sweepLockHeld: boolean
  sweepRestoreMarkSetForHolder: boolean
  /** True iff the holder pane resolves a LIVE registered agents row other than the one being
   * rebound to the adopting pane (conjunct F) — never true for the row this restore is itself
   * moving. */
  holderHasOtherLiveRegisteredRow: boolean
  /** S4's own resume-transcript preflight, already resolved by the caller (async IO). */
  transcriptPreflightPassed: boolean
}

export type HolderAdoptionResult =
  | { adoptable: true; signal: 'IDENTITY' | 'D1' | 'GEN_ABSENCE' }
  | { adoptable: false; reason: HolderAdoptionRefusalReason }

/** DEC-3's conjuncts A-G, pure. Never called when no holder exists (the caller's own
 * null-predecessor path skips this predicate entirely — DEC-2). */
export function resolveHolderAdoption(input: HolderAdoptionInput): HolderAdoptionResult {
  // (A) holder != adopting pane.
  if (input.holderPaneKey === input.adoptingPaneKey) {
    return { adoptable: false, reason: 'same_pane' }
  }
  // (B) both LOCAL_EXECUTION_HOST_ID.
  if (
    input.holderExecutionHostId !== LOCAL_EXECUTION_HOST_ID ||
    input.adoptingExecutionHostId !== LOCAL_EXECUTION_HOST_ID
  ) {
    return { adoptable: false, reason: 'cross_execution_host' }
  }
  // (C) holder's newest launch row is from a PRIOR launch_generation.
  if (input.holderLaunchGeneration === null) {
    return { adoptable: false, reason: 'holder_launch_row_missing' }
  }
  if (input.holderLaunchGeneration === input.currentLaunchGeneration) {
    return { adoptable: false, reason: 'current_generation' }
  }
  // (D) resolveIncumbentDeath = dead with signal IDENTITY or D1, or GEN_ABSENCE (D2 absence over
  // a non-null round AND no connected pty AND no live hook report elsewhere) — D3 never suffices.
  let signal: 'IDENTITY' | 'D1' | 'GEN_ABSENCE' | null = null
  if (
    input.incumbent.dead &&
    (input.incumbent.signal === 'IDENTITY' || input.incumbent.signal === 'D1')
  ) {
    signal = input.incumbent.signal
  } else if (
    input.inventoryRoundNonNull &&
    input.d2Inventory === 'absent' &&
    !input.holderHasConnectedPty &&
    !input.liveHookReportOfSessionElsewhere
  ) {
    signal = 'GEN_ABSENCE'
  }
  if (signal === null) {
    return { adoptable: false, reason: 'death_signal_insufficient' }
  }
  // (E) no restore sweep in flight.
  if (input.sweepLockHeld || input.sweepRestoreMarkSetForHolder) {
    return { adoptable: false, reason: 'sweep_in_flight' }
  }
  // (F) the holder pane's registered agents row, if any, is the row being rebound — any OTHER
  // live registered row on the holder refuses.
  if (input.holderHasOtherLiveRegisteredRow) {
    return { adoptable: false, reason: 'other_live_registered_row' }
  }
  // (G) S4 transcript preflight passed.
  if (!input.transcriptPreflightPassed) {
    return { adoptable: false, reason: 'transcript_preflight_failed' }
  }
  return { adoptable: true, signal }
}
