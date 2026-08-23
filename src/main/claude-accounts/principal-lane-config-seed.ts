import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPlainObject } from '../agent-hooks/hooks-json-read'
import { CLAUDE_AUTH_ENV_VARS } from './environment'
import { LANE_CONFIG_FILENAME } from './principal-lane-credential-sweep'

/**
 * Copied from the host's own `.claude.json` so a lane's first terminal does not sit at an
 * onboarding prompt instead of running. Everything else is absent by construction (S9 §2a).
 *
 * Deliberately NOT here: the per-project trust map (a trust decision belongs to the grant that
 * runs the agent, so each lane re-prompts once per workspace) and project prompt `history`
 * (the other developer's prompts).
 */
export const LANE_SEEDED_CONFIG_KEYS = [
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'theme',
  'autoUpdaterStatus',
  'fallbackAvailableWarningThreshold'
] as const

export type LaneConfigSeedResult = {
  config: Record<string, unknown>
  droppedMcpServers: string[]
}

/**
 * A fresh lane's `.claude.json`: an `oauthAccount` slot the push fills, the onboarding/theme
 * allowlist, and the host's MCP entries — top-level and per-project — minus any whose `env`
 * redirects credential resolution.
 *
 * An MCP entry names a SUBPROCESS and cannot redirect Claude's own credential resolution, so the
 * whole set would be safe to mirror — except an entry whose `env` names `CLAUDE_CONFIG_DIR` or an
 * auth var, which is the one shape that reaches back at the lane.
 */
export function buildFreshLaneConfig(hostConfig: unknown): LaneConfigSeedResult {
  const host = isPlainObject(hostConfig) ? hostConfig : {}
  // Why null and not a fabricated identity: the runtime's own writer treats "no oauthAccount" as
  // an absent key, so the slot stays empty until a real push fills it.
  const config: Record<string, unknown> = { oauthAccount: null }
  for (const key of LANE_SEEDED_CONFIG_KEYS) {
    if (host[key] !== undefined) {
      config[key] = host[key]
    }
  }
  const dropped: string[] = []
  const { servers, dropped: droppedAtTop } = filterMcpServers(host.mcpServers)
  if (servers) {
    config.mcpServers = servers
  }
  dropped.push(...droppedAtTop)
  const projects = mirrorProjectMcpServers(host.projects, dropped)
  if (projects) {
    config.projects = projects
  }
  return { config, droppedMcpServers: Array.from(new Set(dropped)) }
}

/**
 * The per-project half of §2a item (vii): each project entry contributes its MCP wiring and
 * nothing else.
 *
 * A project whose entry carries no MCP wiring is not written at all, so the lane's `projects` map
 * stays absent rather than becoming an empty shell of the host's workspace list.
 */
function mirrorProjectMcpServers(
  value: unknown,
  dropped: string[]
): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    return null
  }
  const projects: Record<string, unknown> = {}
  for (const [projectPath, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      continue
    }
    const mirrored: Record<string, unknown> = {}
    const { servers, dropped: droppedHere } = filterMcpServers(entry.mcpServers)
    if (servers) {
      mirrored.mcpServers = servers
    }
    dropped.push(...droppedHere)
    if (Array.isArray(entry.enabledMcpjsonServers)) {
      mirrored.enabledMcpjsonServers = entry.enabledMcpjsonServers.filter(
        (name) => typeof name === 'string'
      )
    }
    if (Object.keys(mirrored).length > 0) {
      projects[projectPath] = mirrored
    }
  }
  return Object.keys(projects).length > 0 ? projects : null
}

/** Seeds the file only when the lane has none; a loaded lane's own config is never overwritten. */
export function seedFreshLaneConfig(laneDir: string, hostConfigPath: string): LaneConfigSeedResult {
  const laneConfigPath = join(laneDir, LANE_CONFIG_FILENAME)
  const seed = buildFreshLaneConfig(readJsonObject(hostConfigPath))
  if (existsSync(laneConfigPath)) {
    return seed
  }
  writeFileSync(laneConfigPath, `${JSON.stringify(seed.config, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600
  })
  return seed
}

function filterMcpServers(value: unknown): {
  servers: Record<string, unknown> | null
  dropped: string[]
} {
  if (!isPlainObject(value)) {
    return { servers: null, dropped: [] }
  }
  const servers: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [name, entry] of Object.entries(value)) {
    if (redirectsCredentialResolution(entry)) {
      dropped.push(name)
      continue
    }
    servers[name] = entry
  }
  return { servers, dropped }
}

function redirectsCredentialResolution(entry: unknown): boolean {
  if (!isPlainObject(entry) || !isPlainObject(entry.env)) {
    return false
  }
  // Why case-folded: on win32 `claude_config_dir` and `CLAUDE_CONFIG_DIR` are one variable to the
  // child process and two keys to this record.
  const names = Object.keys(entry.env).map((key) => key.toLowerCase())
  return ['CLAUDE_CONFIG_DIR', ...CLAUDE_AUTH_ENV_VARS].some((key) =>
    names.includes(key.toLowerCase())
  )
}

function readJsonObject(path: string): unknown {
  if (!existsSync(path)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown
  } catch {
    return null
  }
}
