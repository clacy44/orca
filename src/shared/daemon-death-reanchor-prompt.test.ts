import { describe, expect, it } from 'vitest'
import {
  DAEMON_DEATH_REANCHOR_PROMPT,
  DAEMON_DEATH_REANCHOR_PROMPT_CHARSET
} from './daemon-death-reanchor-prompt'
import {
  isContinueSelectorToken,
  isForkSessionRefusalToken,
  isResumeSelectorToken,
  isSessionIdRefusalToken
} from './covered-launch-agents'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

describe('DAEMON_DEATH_REANCHOR_PROMPT', () => {
  it('holds the fixed text on one line and stays within [A-Za-z .-]', () => {
    expect(DAEMON_DEATH_REANCHOR_PROMPT).toBe(
      'Orca relaunched this session because the process running it ended when its terminal host died or when Orca or the machine restarted. Treat any tool call or subagent or background shell that was in flight as not finished. Run your re-anchor ritual now. Then check your ledger for that work and resume what did not finish.'
    )
    expect(DAEMON_DEATH_REANCHOR_PROMPT).not.toContain('\n')
    expect(DAEMON_DEATH_REANCHOR_PROMPT_CHARSET.test(DAEMON_DEATH_REANCHOR_PROMPT)).toBe(true)
  })

  it('names the restart and the in-flight work', () => {
    expect(DAEMON_DEATH_REANCHOR_PROMPT).toContain('terminal host died')
    expect(DAEMON_DEATH_REANCHOR_PROMPT).toContain('Orca or the machine restarted')
    expect(DAEMON_DEATH_REANCHOR_PROMPT).toContain('in flight as not finished')
    expect(DAEMON_DEATH_REANCHOR_PROMPT).toContain('re-anchor ritual')
  })

  it('has no quote, expansion or operator character in any shell family', () => {
    for (const forbidden of [
      '"',
      "'",
      '`',
      '%',
      '!',
      '^',
      '&',
      '$',
      ',',
      ';',
      '|',
      '<',
      '>',
      '\\'
    ]) {
      expect(DAEMON_DEATH_REANCHOR_PROMPT).not.toContain(forbidden)
    }
  })

  it('does not start with a dash, so a classifier never reads it as a flag', () => {
    expect(DAEMON_DEATH_REANCHOR_PROMPT.startsWith('-')).toBe(false)
  })

  it('splits into no token that equals a covered refusal or selector token', () => {
    for (const token of DAEMON_DEATH_REANCHOR_PROMPT.split(/\s+/)) {
      expect(isContinueSelectorToken(token)).toBe(false)
      expect(isResumeSelectorToken(token)).toBe(false)
      expect(isSessionIdRefusalToken(token)).toBe(false)
      expect(isForkSessionRefusalToken(token)).toBe(false)
    }
  })

  it('round-trips as exactly one literal token under every shell quoting', () => {
    for (const shell of ['posix', 'powershell', 'cmd'] as AgentStartupShell[]) {
      const tokenized = tokenizeStartupCommand(
        `claude ${quoteStartupArg(DAEMON_DEATH_REANCHOR_PROMPT, shell)}`,
        shell
      )
      expect(tokenized.ok).toBe(true)
      if (tokenized.ok) {
        expect(tokenized.tokens).toEqual(['claude', DAEMON_DEATH_REANCHOR_PROMPT])
        expect(tokenized.spans.some((span) => span.divergesFromShell)).toBe(false)
      }
    }
  })
})
