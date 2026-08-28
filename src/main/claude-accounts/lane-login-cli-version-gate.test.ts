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
  it('accepts the recorded floor and the last-verified build', async () => {
    const { isClaudeCliVersionSupported, MIN_TESTED_CLI_VERSION, LAST_VERIFIED_CLI_VERSION } =
      await import('./lane-login-cli-version-gate')
    expect(isClaudeCliVersionSupported(MIN_TESTED_CLI_VERSION)).toBe(true)
    expect(isClaudeCliVersionSupported(LAST_VERIFIED_CLI_VERSION)).toBe(true)
  })

  it('accepts a version strictly between the floor and the last-verified build', async () => {
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

  // No ceiling any more: a same-major version above LAST_VERIFIED_CLI_VERSION proceeds (with an
  // advisory log — see the `ceiling advisory` describe block below), it is not refused.
  it('accepts a same-major version ABOVE the last-verified build — advisory, not a ceiling', async () => {
    const { isClaudeCliVersionSupported } = await import('./lane-login-cli-version-gate')
    expect(isClaudeCliVersionSupported('2.1.999')).toBe(true)
    expect(isClaudeCliVersionSupported('2.9.0')).toBe(true)
  })

  // A different major IS refused, regardless of whether it numerically exceeds the floor.
  it('refuses a different major version even when it numerically exceeds the floor', async () => {
    const { isClaudeCliVersionSupported } = await import('./lane-login-cli-version-gate')
    expect(isClaudeCliVersionSupported('3.0.0')).toBe(false)
    expect(isClaudeCliVersionSupported('1.9.999')).toBe(false)
  })

  // MP: a "no ceiling" gate that forgot to also compare `major` (patch/minor-only, or a bare
  // `parsed >= min` numeric compare with major treated as just another digit place after an
  // overflow) would wrongly accept 3.0.0 since it is not literally BELOW the floor.
  it('mutation proof: an any-major "at or above the floor" check would wrongly accept 3.0.0', async () => {
    const { parseClaudeCliVersion, isClaudeCliVersionSupported } =
      await import('./lane-login-cli-version-gate')
    const tooNewMajor = parseClaudeCliVersion('3.0.0')!
    const min = parseClaudeCliVersion('2.1.177')!
    const anyMajorAtOrAboveFloorWouldAccept =
      tooNewMajor.major - min.major ||
      tooNewMajor.minor - min.minor ||
      tooNewMajor.patch - min.patch
    expect(anyMajorAtOrAboveFloorWouldAccept >= 0).toBe(true) // ...numerically "at or above"...
    expect(isClaudeCliVersionSupported('3.0.0')).toBe(false) // ...the shipped guard still refuses it.
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
})

describe('ceiling advisory — assertClaudeCliVersionSupported logs, never refuses, on a newer build', () => {
  it('logs exactly one console.info line, worded with the observed and last-verified versions', async () => {
    vi.resetModules()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const { assertClaudeCliVersionSupported, LAST_VERIFIED_CLI_VERSION } =
        await import('./lane-login-cli-version-gate')
      expect(() => assertClaudeCliVersionSupported('2.9.0 (Claude Code)')).not.toThrow()
      expect(infoSpy).toHaveBeenCalledTimes(1)
      const line = infoSpy.mock.calls[0][0] as string
      expect(line).toContain('2.9.0')
      expect(line).toContain(LAST_VERIFIED_CLI_VERSION)
      expect(line).toContain('newer than the last verified')
    } finally {
      infoSpy.mockRestore()
    }
  })

  // Once per PROCESS, not once per call: a second, later assert (a second login attempt) must
  // not re-log.
  it('logs only once across repeated calls in the same module instance', async () => {
    vi.resetModules()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const { assertClaudeCliVersionSupported } = await import('./lane-login-cli-version-gate')
      assertClaudeCliVersionSupported('2.9.0 (Claude Code)')
      assertClaudeCliVersionSupported('2.9.1 (Claude Code)')
      assertClaudeCliVersionSupported('2.9.2 (Claude Code)')
      expect(infoSpy).toHaveBeenCalledTimes(1)
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('does not log for a version at or below the last-verified build', async () => {
    vi.resetModules()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const { assertClaudeCliVersionSupported, LAST_VERIFIED_CLI_VERSION, MIN_TESTED_CLI_VERSION } =
        await import('./lane-login-cli-version-gate')
      assertClaudeCliVersionSupported(LAST_VERIFIED_CLI_VERSION)
      assertClaudeCliVersionSupported(MIN_TESTED_CLI_VERSION)
      expect(infoSpy).not.toHaveBeenCalled()
    } finally {
      infoSpy.mockRestore()
    }
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
