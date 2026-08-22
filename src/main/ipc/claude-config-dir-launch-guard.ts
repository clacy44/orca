import {
  withEnvKeyCollapsed,
  withoutEnvKey,
  withoutEnvKeyDeletion
} from '../../shared/lane-env-key-case'
import { isPathWithinRootForDenial } from '../claude-accounts/canonical-path-containment'

// S9 §2a guard 3: the post-merge CLAUDE_CONFIG_DIR scope assertion both pty.ts spawn
// paths run after their deletion list is applied. Exploitable before lanes exist —
// the zero-lane injection target is a real managed-account store (managed-auth-path.ts).

export const CLAUDE_CONFIG_DIR_ENV_KEY = 'CLAUDE_CONFIG_DIR'

export type ClaudeConfigDirLaunchScope = {
  env: Record<string, string> | undefined
  envToDelete: string[] | undefined
  /** CLAUDE_CONFIG_DIR the host auth patch computed for this spawn, or null. */
  hostConfigDir: string | null
  connectionId: string | null | undefined
  /** `launchConfig.agentEnv`, which path B persists onto the sleeping-agent record. */
  agentEnv?: Record<string, string> | undefined
  /** `<userData>/claude-lanes`, for clause (a)'s second conjunct; null skips it. */
  laneRoot?: string | null
  platform?: NodeJS.Platform
}

export type ClaudeConfigDirLaunchResult = {
  env: Record<string, string> | undefined
  envToDelete: string[] | undefined
  agentEnv: Record<string, string> | undefined
}

/**
 * Two clauses, branching on `connectionId`:
 *
 * - set (SSH/relay pane): the client's own value names a config dir on the REMOTE
 *   host and is left verbatim; a host auth patch here, or any env value pointing at a
 *   host credential lane, would be a host credential crossing to another machine, so
 *   both are hard invariant violations.
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
export function enforceClaudeConfigDirLaunchScope(
  scope: ClaudeConfigDirLaunchScope
): ClaudeConfigDirLaunchResult {
  const { env, envToDelete, hostConfigDir, connectionId, agentEnv } = scope
  const platform = scope.platform ?? process.platform
  if (connectionId) {
    if (hostConfigDir) {
      throw new Error(
        'Refusing to spawn: a host Claude config directory was computed for a remote pane.'
      )
    }
    assertNoLanePathInRemoteEnv(env, scope.laneRoot ?? null)
    return { env, envToDelete, agentEnv }
  }
  const scrubbedAgentEnv = withoutEnvKey(agentEnv, CLAUDE_CONFIG_DIR_ENV_KEY, platform)
  const scrubbedEnvToDelete = withoutEnvKeyDeletion(
    envToDelete,
    CLAUDE_CONFIG_DIR_ENV_KEY,
    platform
  )
  if (hostConfigDir) {
    return {
      env: withEnvKeyCollapsed(env, CLAUDE_CONFIG_DIR_ENV_KEY, hostConfigDir, platform),
      envToDelete: scrubbedEnvToDelete,
      agentEnv: scrubbedAgentEnv
    }
  }
  return {
    env: withoutEnvKey(env, CLAUDE_CONFIG_DIR_ENV_KEY, platform),
    envToDelete: scrubbedEnvToDelete,
    agentEnv: scrubbedAgentEnv
  }
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
    if (isPathWithinRootForDenial(laneRoot, value)) {
      throw new Error(
        `Refusing to spawn: ${key} points inside a host Claude credential lane on a remote pane.`
      )
    }
  }
}
