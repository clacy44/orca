import {
  isClaudeAuthSwitchInProgress,
  SHARED_CLAUDE_LANE_KEY
} from '../claude-accounts/live-pty-gate'
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
import {
  admitAgentLaunch,
  type AdmittedLaunch,
  type AgentLaunchAdmissionContext,
  type LaunchAdmission
} from './agent-launch-admission'
import type { OrchestrationDb } from '../runtime/orchestration/db'

/**
 * The one place `pty.ts` reaches a provider for a *fresh* process (S9 §2 preamble).
 *
 * `attachStablePaneOwner`'s reattach is deliberately not routed here: it passes
 * `attachOnly: true` with no command and then proves it reattached the same incarnation, so it
 * creates nothing a lane computation could govern — and running one over its bare
 * `{ cols, rows, cwd }` would refuse a legitimate reattach whose lane happens to be unloaded.
 *
 * [S10-21a C3-v2, errata 5(p) v2.1 §C.1] `admission` is a REQUIRED 4th parameter — a new
 * fresh-spawn caller anywhere in the tree cannot compile without answering it (§B [v2, R10]).
 * `admitAgentLaunch` runs between the lane computation and the provider call. [D-R104 F-8
 * fix] The (hostId, paneKey) lock it acquires spans ONLY the ownership read + row write —
 * `withPaneLock`'s callback returns before `provider.spawn` runs, so the lock is released
 * BEFORE the spawn, not around it (errata 5(v); a hung spawn cannot wedge the pane for 30s).
 * `confirm`/`compensate` bracket the spawn itself, outside the lock, so the launch-session row
 * this call wrote (if any) is settled before this function returns or throws.
 *
 * [D-R104 F-5] `onAdmitted`, if given, fires right after admission resolves, before
 * `provider.spawn` — the ONLY way a caller can reach the `AdmittedLaunch` this call closes over
 * (it is never returned). pty.ts's `agentSessionOwners.ensure` spawn callback uses it to keep
 * the admitted launch reachable in its OWN enclosing scope, so a throw from `ensure`'s own
 * post-callback promotion logic (after this function already returned successfully) can still
 * call `compensate(true)` on the same row.
 *
 * [D-R105 LOW-2] `admitted.confirm(result)` runs AFTER `provider.spawn` already succeeded — the
 * process is live. A throw from `confirm` itself (its own `ctx.notice`/db call) must never be
 * treated as a spawn failure: `compensate()` (the deleting path) would destroy a row for a
 * process that is provably still running. It gets its own try/catch, audits via
 * `compensate(true)` (audit only, never deletes — `§C.6`: never destroy a fact not proven
 * false) and rethrows, kept OUTSIDE the `provider.spawn` try/catch below so a confirm throw can
 * never reach the deleting `compensate()`.
 */
export async function spawnWithLane<TLaunchConfig extends LaneLaunchConfigInput>(
  provider: IPtyProvider,
  spawnOptions: PtySpawnOptions,
  lane: PaneLaneLaunch<TLaunchConfig>,
  admission: {
    /** [errata 5(p) v2.1] Lazy — see `admitAgentLaunch`'s own doc comment (F-H4). */
    getDb: () => OrchestrationDb | undefined
    launchAdmission: LaunchAdmission
    ctx: AgentLaunchAdmissionContext
  },
  onAdmitted?: (admitted: AdmittedLaunch) => void
): Promise<PtySpawnResult> {
  const computed = computeLaneLaunch(lane, spawnOptions).spawnOptions
  const admitted = await admitAgentLaunch(
    admission.getDb,
    computed,
    admission.launchAdmission,
    admission.ctx
  )
  onAdmitted?.(admitted)
  let result: PtySpawnResult
  try {
    result = await provider.spawn(admitted.spawnOptions)
  } catch (error) {
    admitted.compensate()
    throw error
  }
  try {
    admitted.confirm(result)
  } catch (confirmError) {
    admitted.compensate(true)
    throw confirmError
  }
  return result
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
 * Read against THIS spawn's lane (S9 §2f): a push into lane A refuses lane A's spawns — a plain
 * shell included, which is why `lanePinned` arms it alongside `isClaudeLaunch` — and leaves lane
 * B and the shared lane alone.
 */
export function assertClaudeAuthSwitchNotInProgress(scope: {
  isClaudeLaunch: boolean
  lanePinned: boolean
  lanePrincipalId?: string | null
}): void {
  if (!scope.isClaudeLaunch && !scope.lanePinned) {
    return
  }
  if (isClaudeAuthSwitchInProgress(scope.lanePrincipalId || SHARED_CLAUDE_LANE_KEY)) {
    throw new Error('A Claude account switch is in progress. Try again after it finishes.')
  }
}
