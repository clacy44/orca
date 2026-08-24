import {
  withEnvKeyCollapsed,
  withoutEnvKey,
  withoutEnvKeyDeletion
} from '../../shared/lane-env-key-case'
import { isPathWithinRootForDenial } from '../../shared/lane-path-containment'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'

// S9 §2a guard 3: the post-merge CLAUDE_CONFIG_DIR scope assertion both pty.ts spawn
// paths run after their deletion list is applied. Exploitable before lanes exist —
// the zero-lane injection target is a real managed-account store (managed-auth-path.ts).

export const CLAUDE_CONFIG_DIR_ENV_KEY = 'CLAUDE_CONFIG_DIR'

/** Just enough of `SleepingAgentLaunchConfig` for the scrub; the caller keeps its own type. */
export type LaunchConfigWithAgentEnv = { agentEnv?: Record<string, string> | undefined }

export type ClaudeConfigDirLaunchScope<
  TLaunchConfig extends LaunchConfigWithAgentEnv = LaunchConfigWithAgentEnv
> = {
  env: Record<string, string> | undefined
  envToDelete: string[] | undefined
  /** CLAUDE_CONFIG_DIR the host auth patch computed for this spawn, or null. */
  hostConfigDir: string | null
  /**
   * Whether a host Claude credential preparation exists at all — NOT whether it carried a
   * config dir. The WSL and system preparations return an empty `envPatch` with
   * `stripAuthEnv: true`, so `hostConfigDir === null` cannot stand in for this: clause (a)
   * would stop asserting the moment a preparation without a config dir reaches a remote pane.
   */
  hasHostClaudeAuth: boolean
  connectionId: string | null | undefined
  /** The launch config the caller persists; its `agentEnv` is scrubbed and handed back. */
  launchConfig?: TLaunchConfig | undefined
  /** `<userData>/claude-lanes`, for clause (a)'s second conjunct; null skips it. */
  laneRoot?: string | null
  platform?: NodeJS.Platform
}

export type ClaudeConfigDirLaunchResult<
  TLaunchConfig extends LaunchConfigWithAgentEnv = LaunchConfigWithAgentEnv
> = {
  env: Record<string, string> | undefined
  envToDelete: string[] | undefined
  launchConfig: TLaunchConfig | undefined
}

/**
 * Two clauses, branching on `connectionId`:
 *
 * - set (SSH/relay pane): the client's own value names a config dir on the REMOTE
 *   host and is left verbatim; a host credential preparation here, or any env value
 *   pointing at a host credential lane, would be a host credential crossing to another
 *   machine, so both are hard invariant violations. The preparation is asserted by its
 *   existence, not by whether it produced a config dir — `stripAuthEnv` alone would arm
 *   the auth-var deletion list against a remote host's environment.
 * - absent: a host-computed config dir wins over any client value AND over a client
 *   deletion request; with no host value, no client-supplied one may survive — it is
 *   stripped silently from the env, the deletion list and the persisted `agentEnv`.
 *
 * Deletion counts as much as override: the provider replays `envToDelete` after its
 * own env build (local-pty-provider.ts:702-704 and :734-735, daemon twins
 * pty-subprocess.ts:639/:795), so the list itself must be sanitized, not just the env.
 *
 * Key comparison is case-insensitive on win32 (§2m(5)): Windows resolves env names
 * case-insensitively while this record does not, so a planted `claude_config_dir`
 * would otherwise pass the strip and outrank the host key in the child.
 */
export function enforceClaudeConfigDirLaunchScope<TLaunchConfig extends LaunchConfigWithAgentEnv>(
  scope: ClaudeConfigDirLaunchScope<TLaunchConfig>
): ClaudeConfigDirLaunchResult<TLaunchConfig> {
  const { env, envToDelete, hostConfigDir, hasHostClaudeAuth, connectionId, launchConfig } = scope
  const platform = scope.platform ?? process.platform
  if (connectionId) {
    if (hasHostClaudeAuth) {
      throw new Error(
        'Refusing to spawn: a host Claude credential preparation was computed for a remote pane.'
      )
    }
    assertNoLanePathInRemoteEnv(env, scope.laneRoot ?? null)
    return { env, envToDelete, launchConfig }
  }
  const scopedLaunchConfig = scopeLaunchConfigClaudeConfigDir(launchConfig, {
    connectionId,
    platform
  })
  const scrubbedEnvToDelete = withoutEnvKeyDeletion(
    envToDelete,
    CLAUDE_CONFIG_DIR_ENV_KEY,
    platform
  )
  if (hostConfigDir) {
    // Why an assertion and not a repair: both paths build the env as
    // `{ ...clientEnv, ...claudeAuth.envPatch }`, so the host value already won here — a
    // surviving *different* value could only come from a step between that merge and this
    // anchor, which is the invariant clause (b) exists to catch. Absent is the ordinary
    // case (the client asked for its deletion and `deleteRequestedEnvKeys` obliged), and a
    // non-canonical casing on win32 is a client key, so both are repaired silently below.
    const merged = env?.[CLAUDE_CONFIG_DIR_ENV_KEY]
    if (merged !== undefined && merged !== hostConfigDir) {
      throw new Error(
        'Refusing to spawn: the merged env carries a Claude config directory the host did not compute.'
      )
    }
    return {
      env: withEnvKeyCollapsed(env, CLAUDE_CONFIG_DIR_ENV_KEY, hostConfigDir, platform),
      envToDelete: scrubbedEnvToDelete,
      launchConfig: scopedLaunchConfig
    }
  }
  return {
    env: withoutEnvKey(env, CLAUDE_CONFIG_DIR_ENV_KEY, platform),
    envToDelete: scrubbedEnvToDelete,
    launchConfig: scopedLaunchConfig
  }
}

/**
 * The `launchConfig.agentEnv` half of guard 1, on its own so the runtime-owned create can
 * scrub the record it persists: path A's spawn env is guarded in `pty.ts`, but its
 * `launchConfig` never enters that file, and the sleeping-agent record built from it
 * outlives the spawn and is published back to clients.
 *
 * A remote pane's value names a config dir on the remote host, so it is left verbatim.
 */
export function scopeLaunchConfigClaudeConfigDir<TLaunchConfig extends LaunchConfigWithAgentEnv>(
  launchConfig: TLaunchConfig | undefined,
  options: { connectionId?: string | null | undefined; platform?: NodeJS.Platform }
): TLaunchConfig | undefined {
  if (!launchConfig || options.connectionId) {
    return launchConfig
  }
  const platform = options.platform ?? process.platform
  const scrubbed = withoutEnvKey(launchConfig.agentEnv, CLAUDE_CONFIG_DIR_ENV_KEY, platform)
  return scrubbed === launchConfig.agentEnv ? launchConfig : { ...launchConfig, agentEnv: scrubbed }
}

/**
 * Clause (a)'s second conjunct. A lane path in an SSH pane's env would hand a host
 * credential directory to another machine, whichever variable carried it — so this
 * looks at every value, not only at CLAUDE_CONFIG_DIR.
 */
function assertNoLanePathInRemoteEnv(
  env: Record<string, string> | undefined,
  laneRoot: string | null
): void {
  if (!env || !laneRoot) {
    return
  }
  for (const [key, value] of Object.entries(env)) {
    // Why absolute only: a lane path is always absolute, and resolving a relative value
    // would measure it against main's cwd, which is neither the client's nor the remote's.
    if (isAbsolutePathLike(value) && isPathWithinRootForDenial(laneRoot, value)) {
      throw new Error(
        `Refusing to spawn: ${key} points inside a host Claude credential lane on a remote pane.`
      )
    }
  }
}

function isAbsolutePathLike(value: string): boolean {
  return value.startsWith('/') || isWindowsAbsolutePathLike(value)
}
