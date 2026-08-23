import { isClaudeAuthSwitchInProgress } from '../claude-accounts/live-pty-gate'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import {
  computeLaneLaunch,
  type LaneLaunchConfigInput,
  type PaneLaneLaunch
} from '../runtime/lane-launch-computation'
import type { PaneCredentialLane } from '../runtime/pane-credential-lane-registry'
import type { IPtyProvider, PtySpawnOptions } from '../providers/pty-provider-contract'
import type { PtySpawnResult } from '../providers/pty-spawn-result'

/**
 * The one place `pty.ts` reaches a provider for a *fresh* process (S9 §2 preamble).
 *
 * `attachStablePaneOwner`'s reattach is deliberately not routed here: it passes
 * `attachOnly: true` with no command and then proves it reattached the same incarnation, so it
 * creates nothing a lane computation could govern — and running one over its bare
 * `{ cols, rows, cwd }` would refuse a legitimate reattach whose lane happens to be unloaded.
 */
export async function spawnWithLane<TLaunchConfig extends LaneLaunchConfigInput>(
  provider: IPtyProvider,
  spawnOptions: PtySpawnOptions,
  lane: PaneLaneLaunch<TLaunchConfig>
): Promise<PtySpawnResult> {
  return await provider.spawn(computeLaneLaunch(lane, spawnOptions).spawnOptions)
}

/** The pane a spawn lands in, named the same way on both spawn paths. */
export function paneKeyForLaneLookup(args: { tabId?: string; leafId?: string }): string | null {
  const { tabId, leafId } = args
  return typeof tabId === 'string' &&
    isValidTerminalTabId(tabId) &&
    tabId.length <= 512 &&
    typeof leafId === 'string' &&
    isTerminalLeafId(leafId)
    ? makePaneKey(tabId, leafId)
    : null
}

export type LanePinnedSpawnScope = {
  /** Non-null only for a lane-pinned spawn: a principal row, no `connectionId`. */
  lanePrincipalId: string | null
  /** True when the lane env, the auth strip and the live-PTY registration all arm. */
  lanePinned: boolean
}

/**
 * Whether this spawn is pinned to a principal's lane — read from the PANE RECORD, never from
 * the request, and decoupled from `isClaudeLaunchCommand` (S9 §2a).
 *
 * `connectionId` is an explicit condition rather than the incidental one the command predicate
 * used to supply: an SSH pane's row is `shared` by construction, and asserting it here keeps the
 * exclusion true even if that construction changes.
 */
export function resolveLanePinnedSpawn(args: {
  laneOfPane?: (worktreeId: string, paneKey: string) => PaneCredentialLane | null
  worktreeId?: string
  paneKey: string | null
  connectionId?: string | null
}): LanePinnedSpawnScope {
  const { laneOfPane, worktreeId, paneKey, connectionId } = args
  if (connectionId || !laneOfPane || !worktreeId || !paneKey) {
    return { lanePrincipalId: null, lanePinned: false }
  }
  const lane = laneOfPane(worktreeId, paneKey)
  return lane?.kind === 'principal'
    ? { lanePrincipalId: lane.principalId, lanePinned: true }
    : { lanePrincipalId: null, lanePinned: false }
}

/**
 * The lane bundle the anchor computes over: the row's principal plus the lane-owned inputs.
 *
 * `containmentRoots` is the lane directory and the workspace, the only two places a resume
 * locator may canonicalize under (§2g).
 */
export function paneLaneLaunchFor<TLaunchConfig extends LaneLaunchConfigInput>(args: {
  lanePrincipalId: string | null
  envPatch?: Record<string, string> | null
  workspacePath?: string | null
  launchConfig?: TLaunchConfig | null
  transcriptPath?: string | null
  connectionId?: string | null
}): PaneLaneLaunch<TLaunchConfig> {
  const shared = {
    ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
    ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {}),
    ...(args.connectionId ? { connectionId: args.connectionId } : {})
  }
  if (!args.lanePrincipalId) {
    return { kind: 'shared', ...shared }
  }
  const laneDir = args.envPatch?.CLAUDE_CONFIG_DIR
  return {
    kind: 'principal',
    principalId: args.lanePrincipalId,
    ...(args.envPatch ? { envPatch: args.envPatch } : {}),
    containmentRoots: [laneDir, args.workspacePath].filter((root): root is string => Boolean(root)),
    ...shared
  }
}

/**
 * Row 16: a lane's hook coordinates are §2k's only usage path, so one peer's host-wide
 * `settings.update({ agentStatusHooksEnabled: false })` may not strip them from another
 * principal's lane spawn. The host-wide flag governs shared-lane panes only.
 */
export function laneScopedAgentStatusHooksEnabled(
  lanePinned: boolean,
  hostWideEnabled: boolean
): boolean {
  return lanePinned || hostWideEnabled
}

/**
 * The spawn-side arm of the account-switch gate, on the two conditions that arm it.
 *
 * S9c keys the gate by lane; until then a lane pane joins the host-wide gate, which over-refuses
 * a lane spawn during an unrelated shared-lane switch rather than under-refusing its own.
 */
export function assertClaudeAuthSwitchNotInProgress(scope: {
  isClaudeLaunch: boolean
  lanePinned: boolean
  lanePrincipalId?: string | null
}): void {
  if ((scope.isClaudeLaunch || scope.lanePinned) && isClaudeAuthSwitchInProgress()) {
    throw new Error('A Claude account switch is in progress. Try again after it finishes.')
  }
}
