import { describe, expect, it } from 'vitest'
import {
  applyClaudeEnvPatch,
  hasClaudeAuthEnvConflict,
  resolveClaudeAuthEnvDeletions
} from './environment'

// S9 §2m(5): Windows resolves env names case-insensitively and this record does not, so
// every auth-var comparison folds case on win32 and keeps exact-case semantics on POSIX,
// where two casings really are two variables.
describe('hasClaudeAuthEnvConflict', () => {
  it('sees a lower-cased auth var on win32', () => {
    expect(hasClaudeAuthEnvConflict({ anthropic_api_key: 'sk-ant-x' }, 'win32')).toBe(true)
    expect(hasClaudeAuthEnvConflict({ Anthropic_Auth_Token: 't' }, 'win32')).toBe(true)
  })

  it('sees a lower-cased auth-like ANTHROPIC_CUSTOM_HEADERS on win32', () => {
    expect(hasClaudeAuthEnvConflict({ anthropic_custom_headers: 'x-api-key: sk' }, 'win32')).toBe(
      true
    )
  })

  // Negative control: on POSIX the lower-cased name is a different variable and the CLI
  // never reads it, so refusing the launch would be a false positive.
  it('ignores a lower-cased auth var on linux', () => {
    expect(hasClaudeAuthEnvConflict({ anthropic_api_key: 'sk-ant-x' }, 'linux')).toBe(false)
    expect(hasClaudeAuthEnvConflict({ ANTHROPIC_API_KEY: 'sk-ant-x' }, 'linux')).toBe(true)
  })

  it('ignores an empty auth var on either platform', () => {
    expect(hasClaudeAuthEnvConflict({ anthropic_api_key: '' }, 'win32')).toBe(false)
    expect(hasClaudeAuthEnvConflict({ ANTHROPIC_API_KEY: '' }, 'linux')).toBe(false)
  })
})

describe('applyClaudeEnvPatch', () => {
  it('strips every casing of an auth var on win32', () => {
    const env = applyClaudeEnvPatch(
      { anthropic_api_key: 'sk-ant-x', ANTHROPIC_AUTH_TOKEN: 't', PATH: 'C:\\Windows' },
      {},
      { stripAuthEnv: true, platform: 'win32' }
    )

    expect(env).toEqual({ PATH: 'C:\\Windows' })
  })

  it('strips a lower-cased auth-like ANTHROPIC_CUSTOM_HEADERS on win32', () => {
    const env = applyClaudeEnvPatch(
      { anthropic_custom_headers: 'x-api-key: sk-ant-x' },
      {},
      { stripAuthEnv: true, platform: 'win32' }
    )

    expect(env).toEqual({})
  })

  it('keeps a lower-cased auth var on linux', () => {
    const env = applyClaudeEnvPatch(
      { anthropic_api_key: 'sk-ant-x' },
      {},
      { stripAuthEnv: true, platform: 'linux' }
    )

    expect(env).toEqual({ anthropic_api_key: 'sk-ant-x' })
  })

  it('collapses config-dir casings so the patch value is the only one left on win32', () => {
    const env = applyClaudeEnvPatch(
      { claude_config_dir: 'C:\\victim\\auth' },
      { CLAUDE_CONFIG_DIR: 'C:\\lane\\p1' },
      { platform: 'win32' }
    )

    expect(env).toEqual({ CLAUDE_CONFIG_DIR: 'C:\\lane\\p1' })
  })

  it('leaves a differently-cased config dir alone on linux', () => {
    const env = applyClaudeEnvPatch(
      { claude_config_dir: '/tmp/victim' },
      { CLAUDE_CONFIG_DIR: '/lane/p1' },
      { platform: 'linux' }
    )

    expect(env).toEqual({ claude_config_dir: '/tmp/victim', CLAUDE_CONFIG_DIR: '/lane/p1' })
  })
})

describe('resolveClaudeAuthEnvDeletions', () => {
  it('names the casings the env actually carries on win32', () => {
    const deletions = resolveClaudeAuthEnvDeletions(
      [{ anthropic_api_key: 'sk' }, { Anthropic_Custom_Headers: 'x-api-key: sk' }],
      'win32'
    )

    expect(deletions).toContain('anthropic_api_key')
    expect(deletions).toContain('Anthropic_Custom_Headers')
    expect(deletions).toContain('ANTHROPIC_API_KEY')
  })

  it('does not widen for an unrelated key, or at all on linux', () => {
    expect(resolveClaudeAuthEnvDeletions([{ Path: '/usr/bin' }], 'win32')).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK',
      'ANTHROPIC_CUSTOM_HEADERS'
    ])
    expect(resolveClaudeAuthEnvDeletions([{ anthropic_api_key: 'sk' }], 'linux')).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK',
      'ANTHROPIC_CUSTOM_HEADERS'
    ])
  })
})
