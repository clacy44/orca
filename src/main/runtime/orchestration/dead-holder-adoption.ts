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
  | 'same_generation_settling'
  | 'holder_launch_row_missing'
  | 'death_signal_insufficient'
  | 'live_report_elsewhere'
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
  /** [R142; S10-21f b2b-10q M2] True once the holder's D2 inventory-absence has held for at
   * least REBIND_SETTLE_MS: two (or more) `d2Inventory === 'absent' && !holderHasConnectedPty`
   * readings, taken over NON-NULL rounds, with `now` at the later one at least REBIND_SETTLE_MS
   * past `now` at the first — NOT D3's leaf-based settle window (that signal is always false on
   * a headless `serve` process, where no window ever publishes a leaf record, so it proved only
   * "time since first look"). Required (in addition to the IDENTITY+D2 proof below) before a
   * SAME-generation holder is ever adoptable — this proof alone never sufficed on its own, and
   * here it gates a stricter case than GEN_ABSENCE's, never a looser one. */
  holderSettledNotLive: boolean
  /** True iff the hook server's live provider-session set names session X on ANY pane whose
   * report is not itself resolved as a dead pane's stale report (live-report-liveness.ts). [R143]
   * unknown (the caller could not resolve the hook server's check, or a reporter's own inventory
   * round) collapses to true — the caller's own default, never guessed here. */
  liveHookReportOfSessionOnLivePaneElsewhere: boolean
  sweepLockHeld: boolean
  sweepRestoreMarkSetForHolder: boolean
  /** True iff the holder pane resolves a LIVE registered agents row other than the one being
   * rebound to the adopting pane (conjunct F) — never true for the row this restore is itself
   * moving. */
  holderHasOtherLiveRegisteredRow: boolean
  /** S4's own resume-transcript preflight, already resolved by the caller (async IO). */
  transcriptPreflightPassed: boolean
  /** [R143] Display-only: the reporter pane(s) behind `liveHookReportOfSessionOnLivePaneElsewhere`
   * (already collapsed to a boolean by live-report-liveness.ts) — never consulted for
   * adoptability, only to populate the refusal's `detail`. */
  liveReportReporterPaneKeys?: readonly string[]
}

export type HolderAdoptionResult =
  | { adoptable: true; signal: 'IDENTITY' | 'D1' | 'GEN_ABSENCE' | 'SAME_GEN_PTY_ABSENCE' }
  | { adoptable: false; reason: HolderAdoptionRefusalReason; detail?: string }

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
  // (C) holder's newest launch row is from a PRIOR launch_generation, OR [R142] the SAME
  // generation under a stricter proof below — never guessed from a missing row either way.
  if (input.holderLaunchGeneration === null) {
    return { adoptable: false, reason: 'holder_launch_row_missing' }
  }
  const sameGeneration = input.holderLaunchGeneration === input.currentLaunchGeneration
  // (D) resolveIncumbentDeath = dead with signal IDENTITY or D1, or GEN_ABSENCE (D2 absence over
  // a non-null round AND no connected pty) — D3 never suffices. [S10-21d b3b, D-R163 M2 fix] The
  // live-report conjunct gates ALL three signals, not only GEN_ABSENCE: a second live process
  // reporting X elsewhere contests IDENTITY/D1 exactly as it contests GEN_ABSENCE (DEC-1's
  // contested-state case) — checked FIRST so neither branch below needs its own copy.
  if (input.liveHookReportOfSessionOnLivePaneElsewhere) {
    // [D-R170 M7] Distinct from the ordinary no-death-signal refusal below (:103) — this one
    // fires because another pane's hook report contests the session, which needs a different
    // operator response (investigate that pane / wait out its recency window), not "the D2/pty
    // evidence didn't add up". The CLI prints this reason verbatim. [R143] `detail` names the
    // reporter pane(s) so the operator does not have to re-derive them from the hook state.
    return {
      adoptable: false,
      reason: 'live_report_elsewhere',
      ...(input.liveReportReporterPaneKeys && input.liveReportReporterPaneKeys.length > 0
        ? { detail: `reporter_panes=${input.liveReportReporterPaneKeys.join(',')}` }
        : {})
    }
  }
  let signal: 'IDENTITY' | 'D1' | 'GEN_ABSENCE' | 'SAME_GEN_PTY_ABSENCE' | null = null
  if (sameGeneration) {
    // [R142; S10-21f b2b-10q M2] The launcher itself minted this generation, so an ordinary
    // death signal (even IDENTITY alone) is not trusted here — require identity-death AND the
    // SAME D2/pty-absence proof GEN_ABSENCE uses (IDENTITY and D2 share the ONE round this
    // predicate's caller took, not two independent reads) AND the D2-absence settle window
    // (`holderSettledNotLive`, above), or refuse loudly rather than adopt a pane out from under
    // a still-settling same-generation agent.
    const identityDeadWithPtyAbsence =
      input.incumbent.dead &&
      input.incumbent.signal === 'IDENTITY' &&
      input.inventoryRoundNonNull &&
      input.d2Inventory === 'absent' &&
      !input.holderHasConnectedPty
    if (!identityDeadWithPtyAbsence) {
      return { adoptable: false, reason: 'current_generation' }
    }
    if (!input.holderSettledNotLive) {
      // [M2 follow-up] Operator hint: the caller (chairs.ts) prints `detail` verbatim.
      return {
        adoptable: false,
        reason: 'same_generation_settling',
        detail:
          'the holder pane read absent just now; run `orca chairs restore` again in ≥10 s to confirm'
      }
    }
    signal = 'SAME_GEN_PTY_ABSENCE'
  } else {
    if (
      input.incumbent.dead &&
      (input.incumbent.signal === 'IDENTITY' || input.incumbent.signal === 'D1')
    ) {
      signal = input.incumbent.signal
    } else if (
      input.inventoryRoundNonNull &&
      input.d2Inventory === 'absent' &&
      !input.holderHasConnectedPty
    ) {
      signal = 'GEN_ABSENCE'
    }
    if (signal === null) {
      return { adoptable: false, reason: 'death_signal_insufficient' }
    }
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
