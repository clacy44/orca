import { describe, expect, it } from 'vitest'
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
})
