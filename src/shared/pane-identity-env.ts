import { deleteEnvKeyVariants, findEnvKeyVariants } from './lane-env-key-case'

/**
 * The env keys that name WHICH pane a process is, and the scrub that keeps them from being
 * inherited.
 *
 * Orca can be launched from an Orca terminal, so its own process env may already carry another
 * pane's identity; pane identity belongs to the child PTY, not to the parent shell. Declared once
 * here because there are now three call sites — the local provider, the daemon subprocess and the
 * hidden lane usage probe — and a list that drifts between them silently re-opens the leak
 * (S9 §2k: the paneKey is the usage attribution key, so a stale one misattributes across
 * principals).
 */
export const PANE_IDENTITY_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN'
] as const

/**
 * Removes inherited pane identity unless this spawn explicitly supplies the key.
 *
 * Case-folded on `win32`, where `Orca_Pane_Key` and `ORCA_PANE_KEY` are two keys to Orca and one
 * variable to Win32: an exact-case `delete` leaves the inherited twin, the child's statusline
 * posts it, and the pane→lane join then lands this probe's usage on another principal's row
 * (S9 §2k, §2m(5)) — the same hazard the lane-key collapse beside this call closes.
 */
export function removeUnspecifiedPaneIdentityEnv(
  env: Record<string, string>,
  explicitEnv?: Record<string, string> | undefined,
  platform: NodeJS.Platform = process.platform
): void {
  for (const key of PANE_IDENTITY_ENV_KEYS) {
    if (findEnvKeyVariants(explicitEnv, key, platform).length === 0) {
      deleteEnvKeyVariants(env, [key], platform)
    }
  }
}
