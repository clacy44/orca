import { deleteEnvKeyVariants } from './lane-env-key-case'

/**
 * The env keys that name WHICH Orca a child posts its agent-hook traffic to.
 *
 * Orca can be launched from another Orca's terminal, so its own process env may already carry the
 * other instance's loopback coordinates — and `ORCA_AGENT_HOOK_TOKEN` authenticates. Declared here
 * because the PTY host and the hidden lane usage probe both have to strip them, and a list that
 * drifts between them re-opens the leak silently: the probe's `claude` runs the LANE's managed
 * statusline, which posts `configDir=$CLAUDE_CONFIG_DIR` — the lane path §2a spent a decision
 * making opaque — to whichever hook server the inherited coordinates name (S9 §2k).
 */
export const AGENT_HOOK_RUNTIME_ENV_KEYS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_ENDPOINT',
  // Why: PR 2778 briefly exported this path; keep deleting stale inherited values so older PTYs can't leak the reverted path.
  'ORCA_CLAUDE_AGENT_STATUS_SETTINGS'
] as const

/**
 * Case-folded on `win32`, for the same reason the pane-identity scrub beside it is: `Orca_Agent_
 * Hook_Token` and the upper-case spelling are two keys to Orca and one variable to Win32, so an
 * exact-case delete leaves the inherited twin for the child to resolve (§2m(5)).
 */
export function removeInheritedAgentHookEnv(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): void {
  deleteEnvKeyVariants(env, [...AGENT_HOOK_RUNTIME_ENV_KEYS], platform)
}
