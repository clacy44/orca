// S10-22a G1 repair round (attempt 2), N12: split out of chair-succession-execute.ts (line
// ratchet) — resolves the Run bound to the incumbent's pane for `sealSuccession`, distinguishing
// "no Run at all" from "bound, but legacy" (the two refusals the wave-2 contract requires
// distinctly), both by pane-key EQUIVALENCE (leaf, not exact string) — the same matcher
// `accept-confirm-lock.ts`'s Run-moved check and `getCurrentRunForPane` use. An exact-string
// match (the previous shape) gave a false `succession_no_run` after a tab-half remint.
import { isEquivalentPaneKey, type OrchestrationDb, type RunRow } from './db'
import { OrchestrationError } from './orchestration-error'

/** Throws `succession_no_run` or `succession_legacy_run`; otherwise returns the bound Run. */
export function resolveSealRun(db: OrchestrationDb, paneKey: string): RunRow {
  const run = db.getCurrentRunForPane(paneKey)
  if (run) {
    return run
  }
  // `getCurrentRunForPane` filters `legacy = 0` internally, so it cannot by itself distinguish
  // "no Run at all" from "bound, but legacy" — re-check over the unfiltered list.
  const anyBound = db
    .listRuns()
    .runs.some(
      (r) => r.coordinator_pane_key !== null && isEquivalentPaneKey(r.coordinator_pane_key, paneKey)
    )
  throw new OrchestrationError(
    anyBound ? 'succession_legacy_run' : 'succession_no_run',
    anyBound
      ? 'This pane is bound to a legacy Run.'
      : 'No Run is bound to this pane; succession requires a bound Run.'
  )
}
