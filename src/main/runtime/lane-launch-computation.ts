import { buildAgentNameRe } from '../../shared/agent-name-token-match'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { setEnvKeyCollapsed } from '../../shared/lane-env-key-case'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import {
  assertLaneResumePathsContained,
  sanitizeLaneLaunchCommand,
  sanitizeLaneLaunchEnv,
  type LaneLaunchEnvResult,
  type LaneLaunchRefusal
} from './lane-launch-input-sanitizer'

/** Just enough of `SleepingAgentLaunchConfig` for the computation; callers keep their own type. */
export type LaneLaunchConfigInput = {
  agentCommand?: string
  agentArgs?: string
  agentEnv?: Record<string, string>
  ompResumeFilePath?: string
}

/** Just enough of `PtySpawnOptions`; the anchor hands its own object through unchanged. */
export type LaneLaunchSpawnShape = {
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  launchAgent?: TuiAgent
  credentialLane?: { principalId: string }
}

type LaneLaunchInputs<TLaunchConfig extends LaneLaunchConfigInput> = {
  launchConfig?: TLaunchConfig | null
  transcriptPath?: string | null
  connectionId?: string | null
  platform?: NodeJS.Platform
}

/**
 * The pane's lane as the spawn anchor can see it: the row's own value plus the lane-owned
 * inputs the launch is computed FROM. Nothing on it comes from the launch request.
 */
export type PaneLaneLaunch<TLaunchConfig extends LaneLaunchConfigInput = LaneLaunchConfigInput> =
  | ({ kind: 'shared' } & LaneLaunchInputs<TLaunchConfig>)
  | ({
      kind: 'principal'
      principalId: string
      /** The lane preparation's patch. Absent means the lane is not loaded — a refusal. */
      envPatch?: Record<string, string> | null
      /** The lane directory and the workspace: the only roots a resume path may sit under. */
      containmentRoots?: readonly string[]
    } & LaneLaunchInputs<TLaunchConfig>)

/**
 * Only the spawn options: the anchor governs the PROCESS.
 *
 * The launch config is an INPUT here — guard 2's allowlist, the `agentEnv` auth refusal and §2g's
 * containment read it — and the record built from it is scrubbed of `CLAUDE_CONFIG_DIR` upstream
 * on both paths by guard 3's `scopeLaunchConfigClaudeConfigDir`, so handing a second scrubbed copy
 * back would advertise a delivery this function has no caller for.
 */
export type LaneLaunchComputation<TSpawn extends LaneLaunchSpawnShape> = {
  spawnOptions: TSpawn
}

const OPENCLAUDE_COMMAND_RE = buildAgentNameRe('openclaude')

/** The three host-wide launch-customization settings, as the startup-plan builder reads them. */
export type HostWideAgentLaunchSettings = {
  agentCmdOverrides?: Partial<Record<TuiAgent, string>> | null
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}

export type LaneScopedAgentLaunchSettings = {
  cmdOverrides: Partial<Record<TuiAgent, string>>
  agentDefaultArgs: Partial<Record<TuiAgent, string>> | undefined
  agentDefaultEnv: Partial<Record<TuiAgent, Record<string, string>>> | undefined
}

/**
 * Host-wide launch customization, dropped for a lane launch (S9 §2 rows 13, 14 and 17).
 *
 * `agentDefaultArgs` and `agentDefaultEnv` are writable by ANY paired grant and ungated, so one
 * developer's `settings.update` would otherwise shape the other's lane launch — and a lane's arg
 * overrides belong in that lane's own settings, written only by that principal's push. Emptied
 * rather than filtered: what remains is Orca's own per-agent default, which is host-computed and
 * lane-safe. This is the one site where the host RE-DERIVES a launch from settings inside the
 * spawn path; a value a renderer pre-baked into `launchConfig.agentArgs` upstream is row 8's
 * allowlist instead, and the anchor is where that one is judged.
 */
export function laneScopedAgentLaunchSettings(
  lane: { kind: 'principal' | 'shared' },
  settings: HostWideAgentLaunchSettings
): LaneScopedAgentLaunchSettings {
  if (lane.kind === 'principal') {
    return { cmdOverrides: {}, agentDefaultArgs: undefined, agentDefaultEnv: undefined }
  }
  return {
    cmdOverrides: settings.agentCmdOverrides ?? {},
    agentDefaultArgs: settings.agentDefaultArgs ?? undefined,
    agentDefaultEnv: settings.agentDefaultEnv ?? undefined
  }
}

/** The three inputs a host-side builder feeds an agent launch plan, already lane-scoped. */
export type LaneScopedAgentLaunchInputs = {
  cmdOverrides: Partial<Record<TuiAgent, string>>
  agentArgs: string
  agentEnv: Record<string, string>
}

/**
 * `laneScopedAgentLaunchSettings` as a builder consumes it — one call for the three reads.
 *
 * Every host-side builder that hands `createTerminal` a PRE-BAKED launch takes this instead of
 * reading `settings.agentCmdOverrides` / `agentDefaultArgs` / `agentDefaultEnv` itself: those
 * builders bypass `resolveAgentTerminalCreateOptions` (a caller-supplied `env`/`launchConfig`
 * returns `opts` untouched), so the exclusion has to travel with the lane to each of them or
 * §2 rows 13/14 hold on one site only.
 */
export function laneScopedAgentLaunchInputs(args: {
  lane: { kind: 'principal' | 'shared' }
  settings: HostWideAgentLaunchSettings
  agent: TuiAgent
}): LaneScopedAgentLaunchInputs {
  const scoped = laneScopedAgentLaunchSettings(args.lane, args.settings)
  return {
    cmdOverrides: scoped.cmdOverrides,
    agentArgs: resolveTuiAgentLaunchArgs(args.agent, scoped.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(args.agent, scoped.agentDefaultEnv)
  }
}

/**
 * The closure principle's single computation point (S9 §2a, §2 preamble).
 *
 * A lane launch is *computed*, not customized: every client- and settings-supplied launch input
 * is an input to this function, and the lane's own env is written LAST so nothing host-side can
 * precede it. Runs at the spawn anchor, on every edge, over the lane the PANE record carries —
 * never over a lane named by the request.
 *
 * A shared-lane pane passes through untouched: guard 3 in `pty.ts` is what covers it, and guard 3
 * is armed in the zero-lane state where this function has nothing to compute.
 */
export function computeLaneLaunch<
  TSpawn extends LaneLaunchSpawnShape,
  TLaunchConfig extends LaneLaunchConfigInput
>(paneLane: PaneLaneLaunch<TLaunchConfig>, spawnOptions: TSpawn): LaneLaunchComputation<TSpawn> {
  if (paneLane.kind === 'shared') {
    return { spawnOptions }
  }
  const platform = paneLane.platform ?? process.platform
  assertLanePaneIsLocal(paneLane.connectionId)
  assertLaneRuntimeSupported(spawnOptions.command, spawnOptions.launchAgent)
  assertLaneLoaded(paneLane.envPatch)
  const env = unrefused(
    sanitizeLaneLaunchEnv({
      env: spawnOptions.env,
      envToDelete: spawnOptions.envToDelete,
      agentEnv: paneLane.launchConfig?.agentEnv,
      platform
    })
  )
  unrefused(
    sanitizeLaneLaunchCommand({
      agentCommand: paneLane.launchConfig?.agentCommand,
      agentArgs: paneLane.launchConfig?.agentArgs,
      platform
    })
  )
  unrefused(
    assertLaneResumePathsContained(
      {
        ompResumeFilePath: paneLane.launchConfig?.ompResumeFilePath,
        transcriptPath: paneLane.transcriptPath
      },
      paneLane.containmentRoots ?? []
    )
  )
  // Why last: the two-part post-anchor invariant rests on the lane keys being the final host-side
  // write, so a client value that survived every scrub above is still overwritten here.
  const laneEnv: Record<string, string> = { ...(env.env ?? spawnOptions.env) }
  for (const [key, value] of Object.entries(paneLane.envPatch ?? {})) {
    setEnvKeyCollapsed(laneEnv, key, value, platform)
  }
  return {
    spawnOptions: {
      ...spawnOptions,
      env: laneEnv,
      ...(env.envToDelete ? { envToDelete: env.envToDelete } : {}),
      credentialLane: { principalId: paneLane.principalId }
    }
  }
}

/** The lane preparation must have produced a config dir, or the launch fails closed (§2f). */
function assertLaneLoaded(envPatch: Record<string, string> | null | undefined): void {
  if (!envPatch?.CLAUDE_CONFIG_DIR) {
    throw new ClaudeLaneRefusal(
      'terminal.lane_not_loaded',
      'Your Claude account is not loaded on this host right now, so this terminal cannot start in your credential lane. Reconnect the device that pushes your account, then try again.'
    )
  }
}

/**
 * `connectionId` is an EXPLICIT condition, not the incidental one `isClaudeLaunch` used to give.
 *
 * Before the decoupling an SSH pane never reached a Claude preparation because the command
 * predicate already required `!connectionId`; a lane pane reaches one whatever it runs, so the
 * exclusion has to be stated or a host lane path crosses to another machine (§2a).
 */
function assertLanePaneIsLocal(connectionId: string | null | undefined): void {
  if (connectionId) {
    throw new ClaudeLaneRefusal(
      'terminal.lane_remote_pane',
      'This terminal runs on a remote host over SSH, so Orca will not start it in your personal Claude credential lane — that lane exists only on this machine. Open the terminal locally, or use the remote host’s own Claude account.'
    )
  }
}

/**
 * OpenClaude, fail closed (§2a consequence 3).
 *
 * Whether the binary honors `CLAUDE_CONFIG_DIR` is unverified, and the tree carries no config-dir
 * env for it at all — so a lane pane running it would share one credential store across
 * principals while presence still rendered the row as this person's lane.
 */
function assertLaneRuntimeSupported(command: string | undefined, launchAgent?: TuiAgent): void {
  if (launchAgent === 'openclaude' || (command && OPENCLAUDE_COMMAND_RE.test(command))) {
    throw new ClaudeLaneRefusal(
      'terminal.lane_agent_unsupported',
      'OpenClaude cannot be isolated to a personal Claude credential lane on this host, so Orca did not start it. Launch OpenClaude from a terminal that is not pinned to a lane, or use Claude Code instead.'
    )
  }
}

type LaneLaunchGuardResult =
  | LaneLaunchEnvResult
  | { ok: true }
  | { ok: false; refusal: LaneLaunchRefusal }

/** One throw shape for every guard-1/guard-2 refusal, so callers catch one class. */
function unrefused<TResult extends LaneLaunchGuardResult>(
  result: TResult
): Extract<TResult, { ok: true }> {
  if (!result.ok) {
    throw new ClaudeLaneRefusal(result.refusal.code, result.refusal.message)
  }
  return result as Extract<TResult, { ok: true }>
}
