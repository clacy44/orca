// Why a pure resolver: the restart hedge shown after a Claude account switch is UNCONDITIONAL
// today ("restart live Claude terminals before continuing old sessions"), and S9's per-person lanes
// make that wrong for most terminals — R2 is that a lane re-resolves its account LIVE, with no
// restart (§2h). The hedge must become conditional on the live terminals' lane states, and the
// classification is the part with rules, so it lives here where it can be asserted without a toast.
/**
 * The lane residency states this hedge turns on. It is the shipped `RuntimeTerminalLaneState`
 * (`loaded | absent | reauth-required`) PLUS `restart-required` — §2h's degraded value from the §4
 * live-probe fallback, which the wire type does not yet carry (it is the "restart-required seam",
 * §10(e)). Modelled locally so the classifier is correct the moment that value ships.
 */
export type ClaudeAccountSwitchLaneState =
  | 'loaded'
  | 'absent'
  | 'reauth-required'
  | 'restart-required'

/**
 * What the post-switch hedge should say (S9 §2h, R2 and its degraded path).
 *
 *   - `none`     — every live Claude terminal is a lane that re-resolved the new account live, so
 *                  there is nothing to restart. The switch toast carries no hedge.
 *   - `required` — at least one live terminal cannot pick up the switch without a restart: a
 *                  `restart-required` lane (the §4 live-probe fallback) or a shared/host terminal,
 *                  which is the pre-S9 behaviour the unconditional hedge was written for.
 */
export type ClaudeAccountSwitchRestartHedge = 'none' | 'required'

/**
 * A live Claude terminal, reduced to the only two facts the hedge turns on: whether it runs on a
 * per-person lane at all, and — if so — that lane's residency state.
 */
export type ClaudeAccountSwitchLiveTerminal = {
  /** True for a `'grant'` lane pane; false for a shared/host, remote or WSL terminal. */
  onLane: boolean
  laneState?: ClaudeAccountSwitchLaneState
}

export function resolveClaudeAccountSwitchRestartHedge(
  liveTerminals: readonly ClaudeAccountSwitchLiveTerminal[]
): ClaudeAccountSwitchRestartHedge {
  const needsRestart = liveTerminals.some((terminal) => {
    // A terminal not on a lane is the pre-S9 case: the shared credential materialized under it does
    // not re-resolve, so an old session keeps the previous account until the process restarts.
    if (!terminal.onLane) {
      return true
    }
    // A lane whose live probe failed cannot switch in place — new terminals get the new account,
    // this one keeps the old until it restarts (§2h `'restart-required'`). Every other lane state
    // re-resolves live, which is exactly what R2 promises.
    return terminal.laneState === 'restart-required'
  })
  return needsRestart ? 'required' : 'none'
}
