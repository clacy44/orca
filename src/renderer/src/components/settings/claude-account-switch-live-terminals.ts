// Why a pure mapper beside the classifier: the restart hedge shown after a Claude account switch is
// decided by `resolveClaudeAccountSwitchRestartHedge`, whose input is the live Claude terminals
// reduced to `{ onLane, laneState }`. The desktop has no central `terminal.list` feed (S9 §10(d)),
// so the switch handler reads `terminal.list` point-in-time and reduces it HERE — the projection is
// the part with rules and must be assertable without an RPC.
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'
import type {
  ClaudeAccountSwitchLaneState,
  ClaudeAccountSwitchLiveTerminal
} from './claude-account-switch-restart-hedge'

// Why only these three lanes count: they are the Claude host-credential lanes a local account switch
// can affect. A `'grant'` pane re-resolves the new account live (R2); a `'host'` or `'shared-runtime'`
// pane is the shared credential that does NOT re-resolve, so it is the pre-S9 case the hedge exists
// for. A `'remote'`/`'wsl'`/`'unknown'`/absent lane is not a local Claude credential this switch
// touches at all, so it is excluded rather than counted as a spurious restart.
function toLaneState(
  laneState: RuntimeTerminalSummary['laneState']
): ClaudeAccountSwitchLaneState | undefined {
  switch (laneState) {
    case 'loaded':
    case 'absent':
    case 'reauth-required':
      return laneState
    // Why undefined is its own case: the wire type does not yet carry `'restart-required'` (§10(e)),
    // so a lane with no residency state is simply "no extra fact", not a forced restart.
    case undefined:
      return undefined
  }
}

export function resolveClaudeAccountSwitchLiveTerminals(
  summaries: readonly RuntimeTerminalSummary[]
): ClaudeAccountSwitchLiveTerminal[] {
  const live: ClaudeAccountSwitchLiveTerminal[] = []
  for (const summary of summaries) {
    if (
      summary.credentialLane !== 'grant' &&
      summary.credentialLane !== 'host' &&
      summary.credentialLane !== 'shared-runtime'
    ) {
      continue
    }
    const laneState = toLaneState(summary.laneState)
    live.push({
      onLane: summary.credentialLane === 'grant',
      ...(laneState ? { laneState } : {})
    })
  }
  return live
}
