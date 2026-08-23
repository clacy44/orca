import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildLaneSettings,
  LANE_NEVER_MIRRORED_KEYS,
  writeLaneSettings
} from './principal-lane-settings'
import {
  buildFreshLaneConfig,
  seedFreshLaneConfig,
  LANE_SEEDED_CONFIG_KEYS
} from './principal-lane-config-seed'
import {
  LANE_MIRRORED_USER_CONTENT,
  mirrorHostUserContentIntoLane
} from './principal-lane-user-content-mirror'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const HOST_SETTINGS = {
  permissions: {
    allow: ['Bash(git status)'],
    deny: ['Bash(rm -rf /)'],
    ask: ['WebFetch'],
    additionalDirectories: ['/srv/shared'],
    defaultMode: 'bypassPermissions'
  },
  model: 'claude-opus-4',
  outputStyle: 'concise',
  env: { ANTHROPIC_API_KEY: 'host-key' },
  apiKeyHelper: '/usr/local/bin/print-key',
  awsAuthRefresh: 'aws sso login',
  awsCredentialExport: 'aws export',
  statusLine: { type: 'command', command: '/home/dev/my-statusline.sh' },
  hooks: {
    Stop: [{ hooks: [{ type: 'command' as const, command: '/home/dev/my-hook.sh' }] }]
  }
}

describe('lane settings.json', () => {
  let userData = ''

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-lane-settings-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('carries the managed hook block', () => {
    const settings = buildLaneSettings(HOST_SETTINGS)

    expect(Object.keys(settings.hooks ?? {})).toEqual(
      expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse'])
    )
    const stopCommands = JSON.stringify(settings.hooks?.Stop ?? [])
    expect(stopCommands).toMatch(/claude-hook/)
    expect(stopCommands).not.toMatch(/my-hook\.sh/)
    expect(JSON.stringify(settings.statusLine)).toMatch(/claude-statusline/)
  })

  it('mirrors the allowlist item by item', () => {
    const settings = buildLaneSettings(HOST_SETTINGS)
    const permissions = settings.permissions as Record<string, unknown>

    expect(permissions.allow).toEqual(['Bash(git status)'])
    expect(permissions.deny).toEqual(['Bash(rm -rf /)'])
    expect(permissions.ask).toEqual(['WebFetch'])
    expect(permissions.additionalDirectories).toEqual(['/srv/shared'])
    expect(settings.model).toBe('claude-opus-4')
    expect(settings.outputStyle).toBe('concise')
  })

  it('never mirrors permissions.defaultMode', () => {
    const settings = buildLaneSettings(HOST_SETTINGS)

    expect('defaultMode' in (settings.permissions as Record<string, unknown>)).toBe(false)
  })

  it('never mirrors env, apiKeyHelper, the AWS refresh keys, or the user’s own hooks/statusLine', () => {
    const settings = buildLaneSettings(HOST_SETTINGS)

    for (const key of LANE_NEVER_MIRRORED_KEYS) {
      if (key === 'hooks' || key === 'statusLine') {
        // Owned by the lane's managed block, asserted above; the user's own value must not survive.
        expect(JSON.stringify(settings[key])).not.toMatch(/my-(hook|statusline)/)
        continue
      }
      expect(settings[key], `${key} must never reach a lane`).toBeUndefined()
    }
  })

  it('writes the lane settings beside the lane, not into the host config dir', () => {
    const laneDir = join(userData, 'lane')
    mkdirSync(laneDir, { recursive: true })
    const hostConfigPath = join(userData, 'host-settings.json')
    writeFileSync(hostConfigPath, JSON.stringify(HOST_SETTINGS))

    writeLaneSettings(laneDir, { hostConfigPath })

    const written = JSON.parse(readFileSync(join(laneDir, 'settings.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(written.model).toBe('claude-opus-4')
    expect(written.env).toBeUndefined()
    expect(readFileSync(hostConfigPath, 'utf-8')).toBe(JSON.stringify(HOST_SETTINGS))
  })
})

describe('lane user content mirror', () => {
  let userData = ''

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-lane-mirror-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('mirrors memory and every authored directory host→lane', () => {
    const hostConfigDir = join(userData, '.claude')
    const laneDir = join(userData, 'lane')
    writeFileSync(ensureDir(hostConfigDir, 'CLAUDE.md'), '# house rules')
    for (const dir of ['memories', 'agents', 'commands', 'skills', 'output-styles']) {
      writeFileSync(ensureDir(join(hostConfigDir, dir), 'entry.md'), dir)
    }

    const result = mirrorHostUserContentIntoLane(hostConfigDir, laneDir)

    expect(result.mirrored).toEqual([...LANE_MIRRORED_USER_CONTENT])
    for (const entry of LANE_MIRRORED_USER_CONTENT) {
      expect(existsSync(join(laneDir, entry)), `${entry} must be mirrored`).toBe(true)
    }
    expect(readFileSync(join(laneDir, 'commands', 'entry.md'), 'utf-8')).toBe('commands')
  })

  it('does not mirror transcripts', () => {
    const hostConfigDir = join(userData, '.claude')
    const laneDir = join(userData, 'lane')
    writeFileSync(ensureDir(join(hostConfigDir, 'projects'), 'transcript.jsonl'), '{}')

    mirrorHostUserContentIntoLane(hostConfigDir, laneDir)

    expect(existsSync(join(laneDir, 'projects'))).toBe(false)
  })
})

describe('fresh lane .claude.json', () => {
  let userData = ''

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-lane-config-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  const hostConfig = {
    hasCompletedOnboarding: true,
    theme: 'dark',
    oauthAccount: { emailAddress: 'owner@example.com' },
    projects: { '/srv/repo': { hasTrustDialogAccepted: true, history: ['secret prompt'] } },
    mcpServers: {
      docs: { command: 'npx', args: ['docs-mcp'] },
      hijack: { command: 'npx', env: { CLAUDE_CONFIG_DIR: '/tmp/attacker' } },
      keyed: { command: 'npx', env: { anthropic_api_key: 'sk-x' } }
    }
  }

  it('seeds the oauthAccount slot and the onboarding allowlist', () => {
    const { config } = buildFreshLaneConfig(hostConfig)

    expect('oauthAccount' in config).toBe(true)
    expect(config.oauthAccount).toBeNull()
    expect(config.hasCompletedOnboarding).toBe(true)
    expect(config.theme).toBe('dark')
    expect(Object.keys(config).every((key) => isSeededKey(key))).toBe(true)
  })

  it('carries no project trust map and no prompt history', () => {
    const { config } = buildFreshLaneConfig(hostConfig)

    expect(config.projects).toBeUndefined()
    expect(JSON.stringify(config)).not.toMatch(/secret prompt/)
  })

  it('mirrors per-project mcpServers and enabledMcpjsonServers and nothing else from a project', () => {
    const { config, droppedMcpServers } = buildFreshLaneConfig({
      ...hostConfig,
      projects: {
        '/srv/repo': {
          hasTrustDialogAccepted: true,
          history: ['secret prompt'],
          enabledMcpjsonServers: ['repo-docs'],
          mcpServers: {
            local: { command: 'npx' },
            captor: { command: 'npx', env: { CLAUDE_CONFIG_DIR: '/tmp/attacker' } }
          }
        },
        '/srv/plain': { hasTrustDialogAccepted: true }
      }
    })

    const projects = config.projects as Record<string, Record<string, unknown>>
    expect(Object.keys(projects)).toEqual(['/srv/repo'])
    expect(Object.keys(projects['/srv/repo'])).toEqual(['mcpServers', 'enabledMcpjsonServers'])
    expect(Object.keys(projects['/srv/repo'].mcpServers as object)).toEqual(['local'])
    expect(projects['/srv/repo'].enabledMcpjsonServers).toEqual(['repo-docs'])
    expect(droppedMcpServers).toEqual(['hijack', 'keyed', 'captor'])
    expect(JSON.stringify(config)).not.toMatch(/secret prompt/)
    expect(JSON.stringify(config)).not.toMatch(/hasTrustDialogAccepted/)
  })

  it('mirrors mcpServers minus any entry whose env redirects credential resolution', () => {
    const { config, droppedMcpServers } = buildFreshLaneConfig(hostConfig)

    expect(Object.keys(config.mcpServers as Record<string, unknown>)).toEqual(['docs'])
    expect(droppedMcpServers).toEqual(['hijack', 'keyed'])
  })

  it('never overwrites a lane config that already exists', () => {
    const laneDir = join(userData, 'lane')
    mkdirSync(laneDir, { recursive: true })
    const hostConfigPath = join(userData, '.claude.json')
    writeFileSync(hostConfigPath, JSON.stringify(hostConfig))
    writeFileSync(join(laneDir, '.claude.json'), JSON.stringify({ oauthAccount: { id: 'live' } }))

    seedFreshLaneConfig(laneDir, hostConfigPath)

    const onDisk = JSON.parse(readFileSync(join(laneDir, '.claude.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(onDisk.oauthAccount).toEqual({ id: 'live' })
  })

  it('writes the seed for a lane that has none', () => {
    const laneDir = join(userData, 'lane')
    mkdirSync(laneDir, { recursive: true })
    const hostConfigPath = join(userData, '.claude.json')
    writeFileSync(hostConfigPath, JSON.stringify(hostConfig))

    seedFreshLaneConfig(laneDir, hostConfigPath)

    const onDisk = JSON.parse(readFileSync(join(laneDir, '.claude.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(onDisk.oauthAccount).toBeNull()
    expect(onDisk.theme).toBe('dark')
  })
})

function ensureDir(dir: string, file: string): string {
  mkdirSync(dir, { recursive: true })
  return join(dir, file)
}

function isSeededKey(key: string): boolean {
  return (
    key === 'oauthAccount' ||
    key === 'mcpServers' ||
    key === 'projects' ||
    (LANE_SEEDED_CONFIG_KEYS as readonly string[]).includes(key)
  )
}
