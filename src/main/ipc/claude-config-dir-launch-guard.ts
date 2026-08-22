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
}

export type ClaudeConfigDirLaunchResult = {
  env: Record<string, string> | undefined
  envToDelete: string[] | undefined
}

/**
 * Two clauses, branching on `connectionId`:
 *
 * - set (SSH/relay pane): the client's own value names a config dir on the REMOTE
 *   host and is left verbatim; a host auth patch here would be a host credential
 *   crossing to another machine, so it is a hard invariant violation.
 * - absent: a host-computed config dir wins over any client value AND over a client
 *   deletion request; with no host value, no client-supplied one may survive — it is
 *   stripped silently from both the env and the deletion list.
 *
 * Deletion counts as much as override: the provider replays `envToDelete` after its
 * own env build (local-pty-provider.ts:702-704 and :734-735, daemon twins
 * pty-subprocess.ts:639/:795), so the list itself must be sanitized, not just the env.
 */
export function enforceClaudeConfigDirLaunchScope(
  scope: ClaudeConfigDirLaunchScope
): ClaudeConfigDirLaunchResult {
  const { env, envToDelete, hostConfigDir, connectionId } = scope
  if (connectionId) {
    if (hostConfigDir) {
      throw new Error(
        'Refusing to spawn: a host Claude config directory was computed for a remote pane.'
      )
    }
    return { env, envToDelete }
  }
  if (hostConfigDir) {
    return {
      env: { ...env, [CLAUDE_CONFIG_DIR_ENV_KEY]: hostConfigDir },
      envToDelete: withoutClaudeConfigDirDeletion(envToDelete)
    }
  }
  return {
    env: withoutClaudeConfigDir(env),
    envToDelete: withoutClaudeConfigDirDeletion(envToDelete)
  }
}

function withoutClaudeConfigDir(
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!env || env[CLAUDE_CONFIG_DIR_ENV_KEY] === undefined) {
    return env
  }
  const next = { ...env }
  delete next[CLAUDE_CONFIG_DIR_ENV_KEY]
  return next
}

function withoutClaudeConfigDirDeletion(envToDelete: string[] | undefined): string[] | undefined {
  if (!envToDelete?.includes(CLAUDE_CONFIG_DIR_ENV_KEY)) {
    return envToDelete
  }
  return envToDelete.filter((key) => key !== CLAUDE_CONFIG_DIR_ENV_KEY)
}
