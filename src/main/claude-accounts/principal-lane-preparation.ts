import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { hasLiveClaudePtys } from './live-pty-gate'
import { isLaneWipePending } from './lane-wipe-pending'
import type { NormalizedClaudeAccountSelectionTarget } from './runtime-selection'
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
  // §2f: a wipe that has not confirmed the lane empty still leaves the credential on disk, so a
  // file-presence check would hand this pane the very blob the host has declared wipe-pending.
  if (isLaneWipePending(input.principalId)) {
    throw new ClaudeLaneRefusal(
      'terminal.lane_not_loaded',
      'Orca is clearing your Claude account out of its credential lane on this host, so this terminal was not started in it. Wait for that to finish, reconnect the device that pushes your account, then try again.'
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

/**
 * A lane-pinned launch runs on the host runtime or it does not run (S9 §2a branch order, §2n).
 *
 * A lane is a host-side `<userData>/claude-lanes/<principalId>` path, so handing it to a
 * Linux-side `claude` would create a fresh empty config dir sitting at a login prompt — which is
 * why the WSL arms are evaluated first. Falling THROUGH them, though, runs a lane-pinned pane on
 * the shared WSL config dir while presence renders it as this person's lane and usage bills it to
 * the lane owner. A WSL-visible lane is S9e, and S9e is deferred, so the honest answer is a
 * refusal.
 */
export function assertLaneLaunchRuntimeSupported(
  target: NormalizedClaudeAccountSelectionTarget
): void {
  if (target.runtime !== 'host') {
    throw new ClaudeLaneRefusal(
      'terminal.lane_wsl_unsupported',
      'This terminal runs in a personal Claude credential lane, and lanes are not available inside WSL yet, so Orca did not start it. Open this terminal with a Windows Claude account selected, or use a terminal that is not pinned to a personal lane.'
    )
  }
}
