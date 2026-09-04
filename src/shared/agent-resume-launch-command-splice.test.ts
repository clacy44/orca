// S10-21a C3-v2 (errata 5(p) v2.1 §C.4 HOST_MINTED): the fail-closed span-splice and the
// exported claude-locator, split from agent-resume-launch-command.test.ts to stay under the
// repo's max-lines-for-tests budget (that file is already near it).
import { describe, expect, it } from 'vitest'
import { findClaudeExecutableIndex, spliceHostMintedSessionId } from './agent-resume-launch-command'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'

const SESSION_ID = '11111111-2222-4333-8444-555555555555'

describe('S10-21a C3-v2, errata 5(p) §C.4 HOST_MINTED: spliceHostMintedSessionId', () => {
  it('inserts --session-id <id> immediately after a bare claude command (posix)', () => {
    const result = spliceHostMintedSessionId('claude', SESSION_ID, 'posix')
    expect(result).toEqual({ ok: true, command: `claude --session-id '${SESSION_ID}'` })
  })

  it('inserts right after the claude token, before any trailing user args', () => {
    const result = spliceHostMintedSessionId('claude --model opus', SESSION_ID, 'posix')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    // The inserted flag must land directly after `claude`, not at the end of the line.
    expect(result.command.startsWith(`claude --session-id '${SESSION_ID}' `)).toBe(true)
    expect(result.command).toContain('--model opus')
  })

  it("inserts before claude's own -- terminator", () => {
    const result = spliceHostMintedSessionId('claude -- --weird', SESSION_ID, 'posix')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const tokenized = tokenizeStartupCommand(result.command, 'posix')
    expect(tokenized.ok).toBe(true)
    if (!tokenized.ok) {
      return
    }
    const dashDashIndex = tokenized.tokens.indexOf('--')
    const sessionIdIndex = tokenized.tokens.indexOf('--session-id')
    expect(sessionIdIndex).toBeGreaterThanOrEqual(0)
    expect(dashDashIndex).toBeGreaterThan(sessionIdIndex)
  })

  it('handles Windows shells (powershell/cmd) with shell-appropriate quoting', () => {
    const ps = spliceHostMintedSessionId('claude', SESSION_ID, 'powershell')
    expect(ps).toEqual({ ok: true, command: `claude --session-id '${SESSION_ID}'` })
    const cmd = spliceHostMintedSessionId('claude', SESSION_ID, 'cmd')
    expect(cmd.ok).toBe(true)
  })

  it('FAIL-CLOSED: returns {ok:false} when claude is unlocatable (bash -c wrapper)', () => {
    // findClaudeExecutableIndex only accepts claude at command position of the OUTER tokens; a
    // string embedded as a single quoted argument to another command is not command position.
    const result = spliceHostMintedSessionId('bash -c "claude --model opus"', SESSION_ID, 'posix')
    expect(result).toEqual({ ok: false })
  })

  it('FAIL-CLOSED: returns {ok:false} on an untokenizable command rather than falling back to append', () => {
    // An unterminated quote cannot be tokenized (mirrors buildClaudeResumeLaunchCommand's own
    // divergence discipline, but never appends blind).
    const result = spliceHostMintedSessionId(`claude "unterminated`, SESSION_ID, 'posix')
    expect(result).toEqual({ ok: false })
  })

  it('never string-concatenates: the id is shell-quoted even if it contained shell metacharacters', () => {
    const weirdId = "sess'; rm -rf ~; #"
    const result = spliceHostMintedSessionId('claude', weirdId, 'posix')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const tokenized = tokenizeStartupCommand(result.command, 'posix')
    expect(tokenized.ok).toBe(true)
    if (!tokenized.ok) {
      return
    }
    const idIndex = tokenized.tokens.indexOf('--session-id') + 1
    expect(tokenized.tokens[idIndex]).toBe(weirdId)
    // exactly the two tokens `claude` and `--session-id` plus the quoted id — no stray tokens
    // from unescaped metacharacters.
    expect(tokenized.tokens).toEqual(['claude', '--session-id', weirdId])
  })
})

describe('S10-21a C3-v2: findClaudeExecutableIndex is exported for admission reuse', () => {
  const SHELLS: AgentStartupShell[] = ['posix', 'powershell', 'cmd']

  it.each(SHELLS)('locates claude at index 0 for a bare command (%s)', (shell) => {
    const tokenized = tokenizeStartupCommand('claude', shell)
    expect(tokenized.ok).toBe(true)
    if (!tokenized.ok) {
      return
    }
    expect(findClaudeExecutableIndex(tokenized.tokens, shell)).toBe(0)
  })

  it('returns -1 when claude never appears in command position', () => {
    const tokenized = tokenizeStartupCommand('echo claude', 'posix')
    expect(tokenized.ok).toBe(true)
    if (!tokenized.ok) {
      return
    }
    expect(findClaudeExecutableIndex(tokenized.tokens, 'posix')).toBe(-1)
  })
})
