import { describe, expect, it } from 'vitest'
import {
  envKeysMatch,
  findEnvKeyVariants,
  withEnvKeyCollapsed,
  withoutEnvKey,
  withoutEnvKeyDeletion
} from './lane-env-key-case'

const KEY = 'CLAUDE_CONFIG_DIR'

describe('envKeysMatch', () => {
  it('folds case on win32 only', () => {
    expect(envKeysMatch('claude_config_dir', KEY, 'win32')).toBe(true)
    expect(envKeysMatch('Claude_Config_Dir', KEY, 'win32')).toBe(true)
    expect(envKeysMatch('claude_config_dir', KEY, 'linux')).toBe(false)
    expect(envKeysMatch('claude_config_dir', KEY, 'darwin')).toBe(false)
    expect(envKeysMatch(KEY, KEY, 'linux')).toBe(true)
  })
})

describe('findEnvKeyVariants', () => {
  it('reports every casing on win32 and only the exact key elsewhere', () => {
    const env = { CLAUDE_CONFIG_DIR: '/a', claude_config_dir: '/b', PATH: '/usr/bin' }

    expect(findEnvKeyVariants(env, KEY, 'win32').sort()).toEqual([
      'CLAUDE_CONFIG_DIR',
      'claude_config_dir'
    ])
    expect(findEnvKeyVariants(env, KEY, 'linux')).toEqual(['CLAUDE_CONFIG_DIR'])
    expect(findEnvKeyVariants(undefined, KEY, 'win32')).toEqual([])
  })
})

describe('withoutEnvKey', () => {
  it('removes every casing on win32', () => {
    const env = { CLAUDE_CONFIG_DIR: '/a', claude_config_dir: '/b', PATH: '/usr/bin' }

    expect(withoutEnvKey(env, KEY, 'win32')).toEqual({ PATH: '/usr/bin' })
    expect(withoutEnvKey(env, KEY, 'linux')).toEqual({
      claude_config_dir: '/b',
      PATH: '/usr/bin'
    })
  })

  it('returns the same object when nothing matched, and passes undefined through', () => {
    const env = { PATH: '/usr/bin' }

    expect(withoutEnvKey(env, KEY, 'win32')).toBe(env)
    expect(withoutEnvKey(undefined, KEY, 'win32')).toBeUndefined()
  })
})

describe('withEnvKeyCollapsed', () => {
  it('drops every other casing before writing the canonical key on win32', () => {
    // Why: a record carrying two casings of one Windows variable has undefined precedence,
    // and node-pty emits both entries in insertion order.
    const result = withEnvKeyCollapsed(
      { claude_config_dir: '/victim', PATH: '/usr/bin' },
      KEY,
      '/host',
      'win32'
    )

    expect(result).toEqual({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/host' })
    expect(Object.keys(result)).not.toContain('claude_config_dir')
  })
})

describe('withoutEnvKeyDeletion', () => {
  it('drops every casing of the key from a deletion list on win32', () => {
    expect(withoutEnvKeyDeletion(['Claude_Config_Dir', 'TERM_PROGRAM'], KEY, 'win32')).toEqual([
      'TERM_PROGRAM'
    ])
    expect(withoutEnvKeyDeletion(['Claude_Config_Dir', 'TERM_PROGRAM'], KEY, 'linux')).toEqual([
      'Claude_Config_Dir',
      'TERM_PROGRAM'
    ])
  })

  it('returns the same array when nothing matched, and passes undefined through', () => {
    const list = ['TERM_PROGRAM']

    expect(withoutEnvKeyDeletion(list, KEY, 'win32')).toBe(list)
    expect(withoutEnvKeyDeletion(undefined, KEY, 'win32')).toBeUndefined()
  })
})
