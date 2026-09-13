import { describe, expect, it } from 'vitest'
import { isBareAgentNameTitle, isLaunchCommandEchoTitle } from './shell-authored-title'

describe('T-A: shell-authored title detectors (R185)', () => {
  describe('isBareAgentNameTitle', () => {
    it('matches an exact agent-name token, case-insensitive, with a Windows exe suffix', () => {
      expect(isBareAgentNameTitle('claude')).toBe(true)
      expect(isBareAgentNameTitle('Claude')).toBe(true)
      expect(isBareAgentNameTitle('CLAUDE')).toBe(true)
      expect(isBareAgentNameTitle('codex')).toBe(true)
      expect(isBareAgentNameTitle('claude.exe')).toBe(true)
      expect(isBareAgentNameTitle('  claude  ')).toBe(true)
    })

    it('rejects decorated titles, substrings, and non-AGENT_NAMES tokens', () => {
      expect(isBareAgentNameTitle('✳ x')).toBe(false)
      expect(isBareAgentNameTitle('⠋ Codex')).toBe(false)
      expect(isBareAgentNameTitle('Codex ready')).toBe(false)
      expect(isBareAgentNameTitle('π - proj')).toBe(false)
      expect(isBareAgentNameTitle('OpenClaude running')).toBe(false)
      expect(isBareAgentNameTitle('~/projects/claude')).toBe(false)
      expect(isBareAgentNameTitle('0:1:claude - "x"')).toBe(false)
      // Why: pi/omp/hermes/droid/agy are deliberately NOT in this guard's scope (D-R201 §2).
      expect(isBareAgentNameTitle('droid')).toBe(false)
      expect(isBareAgentNameTitle('hermes')).toBe(false)
      expect(isBareAgentNameTitle('agy')).toBe(false)
    })
  })

  describe('isLaunchCommandEchoTitle', () => {
    it('matches the exact launch command line', () => {
      expect(
        isLaunchCommandEchoTitle(
          'claude --dangerously-skip-permissions --model claude-opus-5',
          'claude --dangerously-skip-permissions --model claude-opus-5'
        )
      ).toBe(true)
    })

    it("matches the shell's first-token form of the command", () => {
      expect(
        isLaunchCommandEchoTitle('claude', 'claude --resume 0f9e1234-aaaa-bbbb-cccc-000000000000')
      ).toBe(true)
      expect(isLaunchCommandEchoTitle('claude', 'sudo claude --resume abc')).toBe(true)
      expect(isLaunchCommandEchoTitle('claude', 'exec claude --resume abc')).toBe(true)
      expect(isLaunchCommandEchoTitle('claude', 'FOO=bar claude --resume abc')).toBe(true)
    })

    it('matches the zsh %100>...> truncated-prefix form', () => {
      const long = `claude --dangerously-skip-permissions --model claude-opus-5 --resume ${'a'.repeat(80)}`
      const truncated = `${long.slice(0, 100)}...`
      expect(isLaunchCommandEchoTitle(truncated, long)).toBe(true)
    })

    it('rejects a cwd title, an unrelated title, and a null/undefined command', () => {
      expect(isLaunchCommandEchoTitle('~/projects/orca', 'claude --resume abc')).toBe(false)
      expect(isLaunchCommandEchoTitle('Codex ready', 'claude --resume abc')).toBe(false)
      expect(isLaunchCommandEchoTitle('claude', null)).toBe(false)
      expect(isLaunchCommandEchoTitle('claude', undefined)).toBe(false)
    })

    it('does not match a tmux window-title shape', () => {
      // Documented as NOT matched: tmux status-line titles are not the shell's preexec echo.
      expect(isLaunchCommandEchoTitle('0:1:claude - "x"', 'claude --resume abc')).toBe(false)
    })
  })
})
