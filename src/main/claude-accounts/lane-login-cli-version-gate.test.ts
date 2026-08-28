import { describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'

const commandMocks = vi.hoisted(() => ({
  resolveClaudeCommand: vi.fn(() => 'claude')
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: commandMocks.resolveClaudeCommand
}))

describe('parseClaudeCliVersion', () => {
  it('parses the leading major.minor.patch out of raw --version output', async () => {
    const { parseClaudeCliVersion } = await import('./lane-login-cli-version-gate')
    expect(parseClaudeCliVersion('2.1.248 (Claude Code)')).toEqual({
      major: 2,
      minor: 1,
      patch: 248
    })
  })

  it('returns null for output with no leading version', async () => {
    const { parseClaudeCliVersion } = await import('./lane-login-cli-version-gate')
    expect(parseClaudeCliVersion('command not found: claude')).toBeNull()
    expect(parseClaudeCliVersion('')).toBeNull()
  })
})

describe('isClaudeCliVersionSupported / assertClaudeCliVersionSupported', () => {
  it('accepts the recorded floor and ceiling, inclusive', async () => {
    const { isClaudeCliVersionSupported, MIN_TESTED_CLI_VERSION, INSTALLED_CLI_VERSION } =
      await import('./lane-login-cli-version-gate')
    expect(isClaudeCliVersionSupported(MIN_TESTED_CLI_VERSION)).toBe(true)
    expect(isClaudeCliVersionSupported(INSTALLED_CLI_VERSION)).toBe(true)
  })

  it('accepts a version strictly between the floor and ceiling', async () => {
    const { isClaudeCliVersionSupported } = await import('./lane-login-cli-version-gate')
    expect(isClaudeCliVersionSupported('2.1.200 (Claude Code)')).toBe(true)
  })

  it('refuses a version below the floor', async () => {
    const { isClaudeCliVersionSupported, assertClaudeCliVersionSupported } =
      await import('./lane-login-cli-version-gate')
    expect(isClaudeCliVersionSupported('2.1.176')).toBe(false)
    expect(isClaudeCliVersionSupported('1.9.999')).toBe(false)
    expect(() => assertClaudeCliVersionSupported('2.1.176')).toThrow()
  })

  it('refuses a version above the ceiling', async () => {
    const { isClaudeCliVersionSupported } = await import('./lane-login-cli-version-gate')
    expect(isClaudeCliVersionSupported('2.1.249')).toBe(false)
    expect(isClaudeCliVersionSupported('3.0.0')).toBe(false)
  })

  // Fail-closed: unparsable output is unsupported, never "assume newest is fine".
  it('refuses unparsable output', async () => {
    const { isClaudeCliVersionSupported } = await import('./lane-login-cli-version-gate')
    expect(isClaudeCliVersionSupported('')).toBe(false)
    expect(isClaudeCliVersionSupported('not a version string')).toBe(false)
  })

  it('assertClaudeCliVersionSupported throws a typed ClaudeLaneRefusal', async () => {
    const { assertClaudeCliVersionSupported } = await import('./lane-login-cli-version-gate')
    try {
      assertClaudeCliVersionSupported('not a version string')
      expect.unreachable()
    } catch (error) {
      expect(isClaudeLaneRefusal(error)).toBe(true)
      expect(isClaudeLaneRefusal(error) ? error.code : null).toBe(
        'accounts.lane.login_cli_unsupported'
      )
      expect(isClaudeLaneRefusal(error) ? error.message.length : 0).toBeGreaterThan(40)
    }
  })

  // MP: a range check that only compares patch numbers (ignoring major/minor)
  // would treat 3.0.0 and 1.9.999 as "close enough" to the recorded range.
  it('mutation proof: a patch-only comparison would wrongly accept an out-of-range major/minor', async () => {
    const { parseClaudeCliVersion } = await import('./lane-login-cli-version-gate')
    const tooNew = parseClaudeCliVersion('3.0.0')!
    const max = parseClaudeCliVersion('2.1.248')!
    const patchOnlyWouldAccept = tooNew.patch <= max.patch
    expect(patchOnlyWouldAccept).toBe(true) // ...the naive comparison is fooled...
    const { isClaudeCliVersionSupported } = await import('./lane-login-cli-version-gate')
    expect(isClaudeCliVersionSupported('3.0.0')).toBe(false) // ...the shipped guard is not.
  })
})

describe('assertLoginCliVersionSupported', () => {
  it('passes through a supported installed version with no throw', async () => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => '2.1.200 (Claude Code)\n')
    }))
    try {
      const { assertLoginCliVersionSupported } = await import('./lane-login-cli-version-gate')
      expect(() => assertLoginCliVersionSupported()).not.toThrow()
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('refuses accounts.lane.login_cli_unsupported when the probe reports an out-of-range version', async () => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => '1.0.0 (Claude Code)\n')
    }))
    try {
      const { assertLoginCliVersionSupported } = await import('./lane-login-cli-version-gate')
      const { isClaudeLaneRefusal: isRefusal } = await import('../../shared/claude-lane-refusals')
      try {
        assertLoginCliVersionSupported()
        expect.unreachable()
      } catch (error) {
        expect(isRefusal(error) ? error.code : null).toBe('accounts.lane.login_cli_unsupported')
      }
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  // Fail closed: a spawn failure (missing binary, PATH issue, timeout) must
  // refuse the login exactly like an out-of-range version, never proceed as
  // if the CLI were supported.
  it('refuses accounts.lane.login_cli_unsupported when the probe itself fails to spawn', async () => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => {
        throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
      })
    }))
    try {
      const { assertLoginCliVersionSupported } = await import('./lane-login-cli-version-gate')
      const { isClaudeLaneRefusal: isRefusal } = await import('../../shared/claude-lane-refusals')
      try {
        assertLoginCliVersionSupported()
        expect.unreachable()
      } catch (error) {
        expect(isRefusal(error) ? error.code : null).toBe('accounts.lane.login_cli_unsupported')
      }
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  // MP: a probe failure that resolved/returned instead of throwing would let a
  // caller mistake a missing-binary condition for "not yet checked" and proceed.
  it('mutation proof: swallowing the spawn error without refusing would not throw here', async () => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => {
        throw new Error('ENOENT')
      })
    }))
    try {
      const { assertLoginCliVersionSupported } = await import('./lane-login-cli-version-gate')
      expect(() => assertLoginCliVersionSupported()).toThrow()
    } finally {
      vi.doUnmock('node:child_process')
    }
  })
})
