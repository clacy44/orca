import { chmodSync } from 'node:fs'
import { writeHooksJson, type HooksConfig } from '../agent-hooks/installer-utils'
import { isPlainObject, readHooksJson } from '../agent-hooks/hooks-json-read'
import {
  applyManagedHooks,
  applyManagedStatusLine,
  CLAUDE_HOOK_SETTINGS,
  getConfigPath,
  getManagedCommand,
  getManagedLifecycleHook,
  getManagedScriptFileName,
  getManagedScriptPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath
} from '../claude/hook-settings'

/**
 * Mirrored host→lane, one-way (S9 §2a): without them every agent re-prompts for every tool, in
 * every lane, permanently.
 */
export const LANE_MIRRORED_PERMISSION_KEYS = [
  'allow',
  'deny',
  'ask',
  'additionalDirectories'
] as const

/** Preferences with no credential influence. */
export const LANE_MIRRORED_SETTINGS_KEYS = ['model', 'outputStyle'] as const

/**
 * NEVER mirrored, item by item: `hooks`/`statusLine` are owned by the lane's managed block, and
 * `env`/`apiKeyHelper`/`awsAuthRefresh`/`awsCredentialExport` are exactly the credential-redirecting
 * keys the lane exists to keep out — a mirrored `apiKeyHelper` OUTRANKS the lane's stored login.
 * `permissions.defaultMode` is excluded too: a host-wide `bypassPermissions` must not silently
 * widen a lane.
 */
export const LANE_NEVER_MIRRORED_KEYS = [
  'env',
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'hooks',
  'statusLine'
] as const

export type LaneSettingsOptions = {
  managedScriptPath?: string
  statusLineScriptPath?: string
}

/**
 * The lane's `settings.json`: the managed hook block plus the mirror allowlist, all computed
 * host-side and nothing client-supplied.
 *
 * `getConfigPath` has no `CLAUDE_CONFIG_DIR` awareness, so a lane launch would otherwise read a
 * settings file that has never been written and lose status hooks and the statusline.
 */
export function buildLaneSettings(
  hostSettings: HooksConfig | null,
  options: LaneSettingsOptions = {}
): HooksConfig {
  const managedScriptPath = options.managedScriptPath ?? getManagedScriptPath(CLAUDE_HOOK_SETTINGS)
  const statusLineScriptPath =
    options.statusLineScriptPath ?? getStatusLineScriptPath(CLAUDE_HOOK_SETTINGS)
  // Why: build from empty rather than from the host file — the mirror is an allowlist, so anything
  // not named below must be absent by construction rather than by removal.
  const withHooks = applyManagedHooks(
    {},
    getManagedLifecycleHook(managedScriptPath, CLAUDE_HOOK_SETTINGS),
    getManagedScriptFileName(CLAUDE_HOOK_SETTINGS)
  )
  const withStatusLine = applyManagedStatusLine(
    withHooks,
    getManagedCommand(statusLineScriptPath),
    getStatusLineScriptFileName(CLAUDE_HOOK_SETTINGS)
  )
  return { ...withStatusLine, ...mirroredSettings(hostSettings) }
}

/** Recomputed at lane creation and on hook refresh; the only lane-scoped override is that grant's push. */
export function writeLaneSettings(
  laneDir: string,
  options: LaneSettingsOptions & { hostConfigPath?: string } = {}
): HooksConfig {
  const hostConfigPath = options.hostConfigPath ?? getConfigPath(CLAUDE_HOOK_SETTINGS)
  const laneSettings = buildLaneSettings(readHooksJson(hostConfigPath), options)
  const laneConfigPath = getConfigPath(CLAUDE_HOOK_SETTINGS, laneDir)
  writeHooksJson(laneConfigPath, laneSettings)
  if (process.platform !== 'win32') {
    // Why: the lane's files are 0600 (§2a); writeHooksJson leaves a new file at the default mode,
    // and on win32 the mode bit is inert — the lane directory's verified DACL is the control there.
    chmodSync(laneConfigPath, 0o600)
  }
  return laneSettings
}

function mirroredSettings(hostSettings: HooksConfig | null): HooksConfig {
  if (!hostSettings) {
    return {}
  }
  const mirrored: HooksConfig = {}
  for (const key of LANE_MIRRORED_SETTINGS_KEYS) {
    if (hostSettings[key] !== undefined) {
      mirrored[key] = hostSettings[key]
    }
  }
  const permissions = mirroredPermissions(hostSettings.permissions)
  if (permissions) {
    mirrored.permissions = permissions
  }
  return mirrored
}

function mirroredPermissions(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    return null
  }
  const mirrored: Record<string, unknown> = {}
  for (const key of LANE_MIRRORED_PERMISSION_KEYS) {
    if (value[key] !== undefined) {
      mirrored[key] = value[key]
    }
  }
  return Object.keys(mirrored).length > 0 ? mirrored : null
}
