import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { hasLiveClaudePtys } from './live-pty-gate'
import { openPrincipalLane, type PrincipalLaneOptions } from './principal-credential-lane'
import { isLaneLoaded } from './principal-lane-credential-sweep'
import { ensureLaneProvenanceLabel, formatLaneProvenance } from './principal-lane-provenance'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth-service'

export type LanePreparationInput = PrincipalLaneOptions & {
  principalId: string
  /**
   * S9b re-keys this to "is a live PTY running in the lane where this account is resident",
   * resolved through the residency index and single-valued by L1. Until the residency index
   * exists, the host's existing live-PTY gate is the honest approximation: it over-defers, which
   * is the safe direction — a double rotation revokes one copy of a single-use refresh token.
   */
  isRefreshDeferredByLivePty?: () => boolean
}

/**
 * The lane arm of `getPreparation` (S9 §2a): the lane path verbatim as `CLAUDE_CONFIG_DIR`.
 *
 * `stripAuthEnv` is unconditionally true — a lane pane that defines Anthropic auth vars is refused
 * and they are deleted from it — and the provenance is `lane:<opaqueLabel>`, which deliberately
 * fails `isManagedClaudeAuth` so the CLI usage supplementation stays scoped to the shared lane.
 */
export function prepareLaneLaunch(input: LanePreparationInput): ClaudeRuntimeAuthPreparation {
  const laneDir = openPrincipalLane(input.principalId, input)
  if (!laneDir) {
    throw new ClaudeLaneRefusal(
      'terminal.lane_not_loaded',
      'This terminal runs in a personal Claude credential lane, and that lane is not set up on this host. Provision it from Orca on the host machine, then open the terminal again.'
    )
  }
  // Why fail closed: falling back to the shared config dir would silently run this pane on the
  // other developer's credential while presence still renders it as this person's lane.
  if (!isLaneLoaded(laneDir)) {
    throw new ClaudeLaneRefusal(
      'terminal.lane_not_loaded',
      'Your Claude account is not loaded on this host right now, so this terminal cannot start in your credential lane. Reconnect the device that pushes your account, then try again.'
    )
  }
  const isDeferred = input.isRefreshDeferredByLivePty ?? hasLiveClaudePtys
  return {
    configDir: laneDir,
    runtime: 'host',
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: { CLAUDE_CONFIG_DIR: laneDir },
    stripAuthEnv: true,
    managedRefreshDeferredByLivePty: isDeferred(),
    provenance: formatLaneProvenance(ensureLaneProvenanceLabel(laneDir))
  }
}
