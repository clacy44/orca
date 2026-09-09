import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, win32 } from 'node:path'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  hookDefinitionHasManagedCommand,
  isPlainObject,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  removeManagedCommands,
  type HookCommandConfig,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import { wrapRuntimeHomeHookCommand } from '../agent-hooks/runtime-home-hook-command'

export type ClaudeCompatibleHookSettings = {
  configDirName: '.claude' | '.openclaude'
  scriptBaseName: 'claude-hook' | 'openclaude-hook'
  supportsExecHookArgs: boolean
}

export const CLAUDE_HOOK_SETTINGS: ClaudeCompatibleHookSettings = {
  configDirName: '.claude',
  scriptBaseName: 'claude-hook',
  supportsExecHookArgs: true
}

export const OPENCLAUDE_HOOK_SETTINGS: ClaudeCompatibleHookSettings = {
  configDirName: '.openclaude',
  scriptBaseName: 'openclaude-hook',
  supportsExecHookArgs: false
}

export const CLAUDE_EVENTS = [
  // Why: SessionStart is the only event a resumed/idle session emits before the
  // first prompt; without it the sidebar row can't exist until the user types (STA-3386).
  { eventName: 'SessionStart', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'UserPromptSubmit', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } },
  // Why: OpenClaude skips normal Stop hooks after API/model errors and emits
  // StopFailure instead; without this hook Orca leaves the turn spinning.
  { eventName: 'StopFailure', definition: { hooks: [{ type: 'command', command: '' }] } },
  // Why: subagent/teammate lifecycle feeds the sidebar's child rows and keeps
  // a pane 'working' while background children outlive the lead's turn.
  // TeammateIdle parks turn-based teammates without trusting their permanently
  // "running" background_tasks entry to gate the pane.
  // Older Claude builds ignore unregistered event names (StopFailure precedent).
  { eventName: 'SubagentStart', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'SubagentStop', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'TeammateIdle', definition: { hooks: [{ type: 'command', command: '' }] } },
  // Why: PreToolUse gives the dashboard a live readout of the in-flight tool
  // (name + input preview) before it completes.
  {
    eventName: 'PreToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUseFailure',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PermissionRequest',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  }
] as const

/**
 * The host's `settings.json`, or — when a lane path is passed — that lane's.
 *
 * A credential lane IS its `CLAUDE_CONFIG_DIR`, so its settings sit directly in it. The lane path
 * is the only `CLAUDE_CONFIG_DIR` awareness here: host behaviour with no argument is unchanged,
 * and the host resolver deliberately does not read the variable (S9 §2a).
 */
export function getConfigPath(settings = CLAUDE_HOOK_SETTINGS, laneConfigDir?: string): string {
  return laneConfigDir
    ? join(laneConfigDir, 'settings.json')
    : join(homedir(), settings.configDirName, 'settings.json')
}

export function getStatusLineScriptBaseName(settings = CLAUDE_HOOK_SETTINGS): string {
  return settings.scriptBaseName.replace(/-hook$/, '-statusline')
}

export function getStatusLineScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return process.platform === 'win32'
    ? `${getStatusLineScriptBaseName(settings)}.cmd`
    : getPosixStatusLineScriptFileName(settings)
}

export function getPosixStatusLineScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return `${getStatusLineScriptBaseName(settings)}.sh`
}

export function getStatusLineScriptPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return getSharedManagedScriptPath(getStatusLineScriptFileName(settings))
}

export function getManagedScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return process.platform === 'win32'
    ? `${settings.scriptBaseName}.cmd`
    : getPosixManagedScriptFileName(settings)
}

export function getPosixManagedScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return `${settings.scriptBaseName}.sh`
}

export function getManagedScriptPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return getSharedManagedScriptPath(getManagedScriptFileName(settings))
}

export function getRemoteConfigPath(remoteHome: string, settings = CLAUDE_HOOK_SETTINGS): string {
  return `${remoteHome.replace(/\/$/, '')}/${settings.configDirName}/settings.json`
}

export function getManagedCommand(scriptPath: string): string {
  const scriptFileName = basename(scriptPath)
  const extension = extname(scriptFileName)
  return wrapRuntimeHomeHookCommand(
    extension ? scriptFileName.slice(0, -extension.length) : scriptFileName
  )
}

// Returns null only for the Windows exec-form path (Claude) when orca-hook-host.exe is absent
// from this build (M3) — every other agent/platform combination always returns a hook.
export function getManagedLifecycleHook(
  scriptPath: string,
  settings = CLAUDE_HOOK_SETTINGS,
  resourcesPath?: string
): HookCommandConfig | null {
  if (process.platform !== 'win32' || !settings.supportsExecHookArgs) {
    return buildManagedCommandHook(getManagedCommand(scriptPath))
  }
  return getWindowsManagedLifecycleHook(scriptPath, resourcesPath ?? readResourcesPath())
}

// Why not `process.resourcesPath` directly: this file is also compiled under the CLI's
// tsconfig (tsconfig.cli.json), which never loads Electron's ambient `Process` augmentation —
// a direct reference fails that build with TS2339. Mirrors the runtime-only-if-present check
// daemon-host-relocation.ts uses for the same field.
function readResourcesPath(): string | undefined {
  const candidate = (process as unknown as { resourcesPath?: unknown }).resourcesPath
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

// M3 (chair decision, D-R166-lane3-b1c-review.md): conhost gives cmd.exe a headless
// pseudoconsole that SWALLOWS Claude's stdin payload (field-proven,
// drills/readouts/E-R105-desktop-2026-09-08.md) — a dev/unpackaged build without
// orca-hook-host.exe must NEVER fall back to that (or any) shelled-out form. Returning null
// instead is the contract: the caller (hook-service.ts install()) leaves any existing managed
// entry untouched and writes no new lifecycle entry; getStatus() surfaces this loudly via
// state 'skipped' / skipReason 'windows_hook_host_unavailable', not just a console line.
let loggedMissingWindowsHookHostOnce = false

export function getWindowsManagedLifecycleHook(
  scriptPath: string,
  resourcesPath: string | undefined = readResourcesPath()
): HookCommandConfig | null {
  // Why plain `join`, not `win32.join`: resourcesPath is always the running process's own
  // (OS-native) resourcesPath — on real Windows that's already backslash-form, so `join` and
  // `win32.join` agree there; on a non-Windows dev/test host (this exe-path is also unit-tested
  // with a real POSIX tmpdir standing in for resourcesPath) `win32.join` would silently mangle
  // that into a string existsSync can never resolve, so exe presence would never be detected.
  const hookHostExePath = resourcesPath ? join(resourcesPath, 'bin', 'orca-hook-host.exe') : null
  if (hookHostExePath && existsSync(hookHostExePath)) {
    const scriptStem = win32.basename(scriptPath, win32.extname(scriptPath))
    const runtimeDescriptorPath = win32.join(
      '%USERPROFILE%',
      '.orca',
      'agent-hooks',
      `${scriptStem}.json`
    )
    return {
      type: 'command',
      command: hookHostExePath,
      args: ['--descriptor', runtimeDescriptorPath],
      timeout: MANAGED_HOOK_TIMEOUT_SECONDS
    }
  }
  if (!loggedMissingWindowsHookHostOnce) {
    loggedMissingWindowsHookHostOnce = true
    console.error(
      `[agent-hooks] orca-hook-host.exe not found at ${hookHostExePath ?? '<no resourcesPath>'}; ` +
        'Windows lifecycle hooks are unavailable in this build (expected on a dev/unpackaged ' +
        'build that has not run build:native) — see getStatus().skipReason.'
    )
  }
  return null
}

// Field order matches buildWindowsAgentHookCurlPostCommand (installer-utils.ts:182-198); kept in
// sync by hand with native/windows-hook-host/OrcaHookHost.cs's BuiltInDescriptor.
export const WINDOWS_HOOK_HOST_DESCRIPTOR_FIELDS = [
  'paneKey',
  'tabId',
  'launchToken',
  'worktreeId',
  'env',
  'version',
  'payload'
] as const

export type WindowsHookHostDescriptor = {
  source: 'claude'
  pathname: string
  fields: readonly string[]
}

export function getWindowsHookHostDescriptorFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return `${settings.scriptBaseName}.json`
}

export function getWindowsHookHostDescriptorPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return getSharedManagedScriptPath(getWindowsHookHostDescriptorFileName(settings))
}

export function buildWindowsHookHostDescriptor(
  pathname = '/hook/claude'
): WindowsHookHostDescriptor {
  return { source: 'claude', pathname, fields: WINDOWS_HOOK_HOST_DESCRIPTOR_FIELDS }
}

export function hasSameManagedHookInvocation(
  actual: HookCommandConfig,
  expected: HookCommandConfig
): boolean {
  return (
    actual.command === expected.command &&
    JSON.stringify(actual.args ?? []) === JSON.stringify(expected.args ?? [])
  )
}

export function getRemoteManagedCommand(scriptPath: string): string {
  return getManagedCommand(scriptPath)
}

export function applyManagedHooks(
  config: HooksConfig,
  hook: HookCommandConfig,
  scriptFileName = getManagedScriptFileName()
): HooksConfig {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)

  for (const event of CLAUDE_EVENTS) {
    const current = Array.isArray(nextHooks[event.eventName]) ? nextHooks[event.eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const definition: HookDefinition = {
      ...event.definition,
      hooks: [hook]
    }
    nextHooks[event.eventName] = [...cleaned, definition]
  }

  return { ...config, hooks: nextHooks }
}

// M3: used only when getManagedLifecycleHook() returned null (exe absent) — reports whether
// ANY managed entry (any generation: exe-form, conhost, cmd.exe-direct) already exists, so
// getStatus() can tell "left an existing install untouched" from "never installed" without
// computing an `expectedHook` to compare against (there isn't one to write).
export function hasAnyManagedLifecycleHook(
  config: HooksConfig,
  scriptFileName = getManagedScriptFileName()
): boolean {
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  return CLAUDE_EVENTS.some((event) => {
    const definitions = Array.isArray(config.hooks?.[event.eventName])
      ? config.hooks![event.eventName]!
      : []
    // Why hookDefinitionHasManagedCommand, not a bare `hook.command` check: the conhost/
    // cmd.exe-direct generations carry the identifying script path in `args`, not `command`
    // (command is conhost.exe/cmd.exe itself) — this is the same matcher removeManagedCommands
    // uses to sweep every generation, so "any managed generation present" stays in sync with it.
    return definitions.some((definition) =>
      hookDefinitionHasManagedCommand(definition, isManagedCommand)
    )
  })
}

// M3: orca-hook-host.exe absent from this build (dev/unpackaged, no build:native yet) — never
// surfaced as 'error' (nothing is broken) or silently as 'installed' (nothing was written).
export const WINDOWS_HOOK_HOST_UNAVAILABLE_DETAIL =
  'orca-hook-host.exe was not found in this build; Windows lifecycle hooks for Claude are ' +
  'unavailable until a build that runs build:native (or build) is installed.'

// Builds the loud getStatus() reply for the M3 exe-absent case — shared so hook-service.ts's
// getStatus() needs only one call site instead of constructing the object inline.
export function buildWindowsHookHostUnavailableStatus(
  options: { agent: AgentHookInstallStatus['agent']; settings: ClaudeCompatibleHookSettings },
  configPath: string,
  config: HooksConfig
): AgentHookInstallStatus {
  const scriptFileName = getManagedScriptFileName(options.settings)
  return {
    agent: options.agent,
    state: 'skipped',
    configPath,
    managedHooksPresent: hasAnyManagedLifecycleHook(config, scriptFileName),
    detail: WINDOWS_HOOK_HOST_UNAVAILABLE_DETAIL,
    skipReason: 'windows_hook_host_unavailable'
  }
}

export type StatusLineSlotState = 'managed' | 'user' | 'empty'

// Why: install policy needs "user owns the slot" vs "slot is empty" vs "ours" — an empty slot
// after a prior install means the user deleted the managed entry, which install must respect.
export function getStatusLineSlotState(
  config: HooksConfig,
  scriptFileName = getStatusLineScriptFileName()
): StatusLineSlotState {
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const current = config.statusLine
  const currentCommand =
    isPlainObject(current) && typeof current.command === 'string' ? current.command : null
  if (!currentCommand) {
    return 'empty'
  }
  return isManagedCommand(currentCommand) ? 'managed' : 'user'
}

// Why: records that the managed statusline was installed once, so a later empty slot reads as user opt-out.
export function getStatusLineInstallMarkerPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return getSharedManagedScriptPath(`${getStatusLineScriptBaseName(settings)}.installed`)
}

// Why: statusLine is a single settings slot, not a hooks array — never overwrite a
// user-owned status line; the usage feed then simply falls back to the OAuth poll.
export function applyManagedStatusLine(
  config: HooksConfig,
  command: string,
  scriptFileName = getStatusLineScriptFileName()
): HooksConfig {
  if (getStatusLineSlotState(config, scriptFileName) === 'user') {
    return config
  }
  return { ...config, statusLine: { type: 'command', command } }
}

export function removeManagedStatusLine(
  config: HooksConfig,
  scriptFileName = getStatusLineScriptFileName()
): { config: HooksConfig; changed: boolean } {
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const current = config.statusLine
  const currentCommand =
    isPlainObject(current) && typeof current.command === 'string' ? current.command : null
  if (!currentCommand || !isManagedCommand(currentCommand)) {
    return { config, changed: false }
  }
  const next = { ...config }
  delete next.statusLine
  return { config: next, changed: true }
}

export function removeManagedHooks(
  config: HooksConfig,
  scriptFileName = getManagedScriptFileName()
): {
  config: HooksConfig
  changed: boolean
} {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  let changed = false

  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (JSON.stringify(cleaned) !== JSON.stringify(definitions)) {
      changed = true
    }
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  return {
    config: { ...config, hooks: nextHooks },
    changed
  }
}
