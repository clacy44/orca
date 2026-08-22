import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enforceClaudeConfigDirLaunchScope } from './claude-config-dir-launch-guard'

describe('enforceClaudeConfigDirLaunchScope', () => {
  it('strips a client config dir when the host computed none', () => {
    const result = enforceClaudeConfigDirLaunchScope({
      env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/tmp/orca-user-data/claude-accounts/x/auth' },
      envToDelete: ['TERM_PROGRAM'],
      hostConfigDir: null,
      connectionId: null
    })

    expect(result.env).toEqual({ PATH: '/usr/bin' })
    expect(result.envToDelete).toEqual(['TERM_PROGRAM'])
  })

  it('drops a client CLAUDE_CONFIG_DIR deletion request even with no host value', () => {
    // Why: the provider replays envToDelete post-build, so a stale list would delete a later host value.
    const result = enforceClaudeConfigDirLaunchScope({
      env: { PATH: '/usr/bin' },
      envToDelete: ['CLAUDE_CONFIG_DIR', 'TERM_PROGRAM'],
      hostConfigDir: null,
      connectionId: null
    })

    expect(result.envToDelete).toEqual(['TERM_PROGRAM'])
  })

  it('restores the host config dir over a client override and a client deletion', () => {
    const result = enforceClaudeConfigDirLaunchScope({
      env: { PATH: '/usr/bin' },
      envToDelete: ['CLAUDE_CONFIG_DIR'],
      hostConfigDir: '/home/me/.orca-claude/acct-1',
      connectionId: null
    })

    expect(result.env?.CLAUDE_CONFIG_DIR).toBe('/home/me/.orca-claude/acct-1')
    expect(result.envToDelete).toEqual([])
  })

  it('refuses a merged env whose config dir is not the host-computed one', () => {
    // Why reachable only from a future regression: both spawn paths spread the auth patch
    // over the client env, so an unequal value means something rewrote it after the merge.
    expect(() =>
      enforceClaudeConfigDirLaunchScope({
        env: { CLAUDE_CONFIG_DIR: '/tmp/somewhere-else' },
        envToDelete: undefined,
        hostConfigDir: '/home/me/.orca-claude/acct-1',
        connectionId: null
      })
    ).toThrow(/the host did not compute/)
  })

  it('repairs, rather than refuses, a client key in a non-canonical casing on win32', () => {
    const result = enforceClaudeConfigDirLaunchScope({
      env: { claude_config_dir: 'C:\\victim' },
      envToDelete: undefined,
      hostConfigDir: 'C:\\host\\lane',
      connectionId: null,
      platform: 'win32'
    })

    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: 'C:\\host\\lane' })
  })

  it('leaves a remote pane env untouched', () => {
    const env = { CLAUDE_CONFIG_DIR: '/home/remote/.claude-work' }
    const envToDelete = ['CLAUDE_CONFIG_DIR']

    const result = enforceClaudeConfigDirLaunchScope({
      env,
      envToDelete,
      hostConfigDir: null,
      connectionId: 'ssh-1'
    })

    expect(result.env).toBe(env)
    expect(result.envToDelete).toBe(envToDelete)
  })

  it('refuses a host config dir on a remote pane', () => {
    expect(() =>
      enforceClaudeConfigDirLaunchScope({
        env: {},
        envToDelete: undefined,
        hostConfigDir: '/home/me/.orca-claude/acct-1',
        connectionId: 'ssh-1'
      })
    ).toThrow(/remote pane/)
  })

  it('leaves an absent env and deletion list absent', () => {
    const result = enforceClaudeConfigDirLaunchScope({
      env: undefined,
      envToDelete: undefined,
      hostConfigDir: null,
      connectionId: undefined
    })

    expect(result.env).toBeUndefined()
    expect(result.envToDelete).toBeUndefined()
  })

  it('scrubs a client CLAUDE_CONFIG_DIR out of the persisted agentEnv', () => {
    // Why: path B folds launchConfig.agentEnv into the sleeping-agent record upstream of the
    // spawn env, so a value neutralised at spawn would still survive in the session store.
    const result = enforceClaudeConfigDirLaunchScope({
      env: { PATH: '/usr/bin' },
      envToDelete: undefined,
      agentEnv: { CLAUDE_CONFIG_DIR: '/tmp/victim', ORCA_TAB_ID: 't1' },
      hostConfigDir: null,
      connectionId: null
    })

    expect(result.agentEnv).toEqual({ ORCA_TAB_ID: 't1' })
  })

  it('leaves a remote pane agentEnv untouched', () => {
    const agentEnv = { CLAUDE_CONFIG_DIR: '/home/remote/.claude-work' }

    const result = enforceClaudeConfigDirLaunchScope({
      env: {},
      envToDelete: undefined,
      agentEnv,
      hostConfigDir: null,
      connectionId: 'ssh-1'
    })

    expect(result.agentEnv).toBe(agentEnv)
  })

  describe('win32 env-key case folding', () => {
    it('strips a lower-cased client key that Windows would resolve as the real one', () => {
      const result = enforceClaudeConfigDirLaunchScope({
        env: { PATH: 'C:\\Windows', claude_config_dir: 'C:\\victim\\auth' },
        envToDelete: undefined,
        hostConfigDir: null,
        connectionId: null,
        platform: 'win32'
      })

      expect(result.env).toEqual({ PATH: 'C:\\Windows' })
    })

    it('collapses case variants when the host computed a config dir', () => {
      const result = enforceClaudeConfigDirLaunchScope({
        env: { claude_config_dir: 'C:\\victim\\auth' },
        envToDelete: ['Claude_Config_Dir'],
        hostConfigDir: 'C:\\host\\lane',
        connectionId: null,
        platform: 'win32'
      })

      expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: 'C:\\host\\lane' })
      expect(result.envToDelete).toEqual([])
    })

    it('scrubs a lower-cased key from agentEnv too', () => {
      const result = enforceClaudeConfigDirLaunchScope({
        env: {},
        envToDelete: undefined,
        agentEnv: { Claude_Config_Dir: 'C:\\victim\\auth' },
        hostConfigDir: null,
        connectionId: null,
        platform: 'win32'
      })

      expect(result.agentEnv).toEqual({})
    })

    it('keeps a lower-cased key on posix, where it is a different variable', () => {
      const result = enforceClaudeConfigDirLaunchScope({
        env: { claude_config_dir: '/tmp/victim' },
        envToDelete: undefined,
        hostConfigDir: null,
        connectionId: null,
        platform: 'linux'
      })

      expect(result.env).toEqual({ claude_config_dir: '/tmp/victim' })
    })
  })

  describe('clause (a): no host lane path may reach a remote pane', () => {
    let userData = ''
    let elsewhere = ''

    beforeAll(() => {
      userData = mkdtempSync(join(tmpdir(), 'orca-guard3-userdata-'))
      elsewhere = mkdtempSync(join(tmpdir(), 'orca-guard3-elsewhere-'))
    })

    afterAll(() => {
      rmSync(userData, { recursive: true, force: true })
      rmSync(elsewhere, { recursive: true, force: true })
    })

    const laneRoot = (): string => join(userData, 'claude-lanes')

    it('refuses a lane path carried by any env key, not only CLAUDE_CONFIG_DIR', () => {
      expect(() =>
        enforceClaudeConfigDirLaunchScope({
          env: { ORCA_SOMETHING: join(laneRoot(), 'principal-a') },
          envToDelete: undefined,
          hostConfigDir: null,
          connectionId: 'ssh-1',
          laneRoot: laneRoot()
        })
      ).toThrow(/credential lane on a remote pane/)
    })

    it('refuses a lane path reached through a symlink', () => {
      const lane = join(laneRoot(), 'principal-b')
      mkdirSync(lane, { recursive: true })
      const decoy = join(elsewhere, 'decoy')
      symlinkSync(lane, decoy)

      expect(() =>
        enforceClaudeConfigDirLaunchScope({
          env: { CLAUDE_CONFIG_DIR: decoy },
          envToDelete: undefined,
          hostConfigDir: null,
          connectionId: 'ssh-1',
          laneRoot: laneRoot()
        })
      ).toThrow(/credential lane on a remote pane/)
    })

    it('still allows a remote config dir that is not a lane path', () => {
      const env = { CLAUDE_CONFIG_DIR: '/home/remote-dev/.claude-work', TERM: 'xterm-256color' }

      const result = enforceClaudeConfigDirLaunchScope({
        env,
        envToDelete: undefined,
        hostConfigDir: null,
        connectionId: 'ssh-1',
        laneRoot: laneRoot()
      })

      expect(result.env).toBe(env)
    })
  })
})
