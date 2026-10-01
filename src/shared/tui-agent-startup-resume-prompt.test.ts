// R315 S1: a chair relaunched after its terminal host died gets a fixed re-anchor prompt as the
// LAST argv token of its Claude `--resume` command. Never persisted into the launch config, and
// omitted whenever the claude token cannot be located and spliced.
import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'
import { buildAgentResumeLaunchCommand } from './agent-resume-launch-command'
import { DAEMON_DEATH_REANCHOR_PROMPT } from './daemon-death-reanchor-prompt'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

const SESSION_ID = 'claude-session-reanchor-1'
const providerSession = { key: 'session_id', id: SESSION_ID } as const
const PROMPT = DAEMON_DEATH_REANCHOR_PROMPT

function plan(
  extra: Partial<Parameters<typeof buildAgentResumeStartupPlan>[0]> = {},
  resumePrompt: string | null = PROMPT
) {
  return buildAgentResumeStartupPlan({
    agent: 'claude',
    providerSession,
    cmdOverrides: {},
    platform: 'linux',
    ...(resumePrompt === null ? {} : { resumePrompt }),
    ...extra
  })
}

function tokensOf(command: string, shell: AgentStartupShell): string[] {
  const tokenized = tokenizeStartupCommand(command, shell)
  if (!tokenized.ok) {
    throw new Error(`untokenizable: ${command}`)
  }
  return tokenized.tokens
}

describe('buildAgentResumeStartupPlan: resumePrompt (R315 S1)', () => {
  it('appends the prompt as the last token, after --resume <id>', () => {
    const result = plan()
    expect(result?.launchCommand).toBe(`claude '--resume' '${SESSION_ID}' '${PROMPT}'`)
    expect(tokensOf(result!.launchCommand, 'posix').at(-1)).toBe(PROMPT)
  })

  it('appends after the re-appended --model/--effort as well', () => {
    const result = plan({ sessionOptions: { model: 'claude-opus-4-8', effort: 'max' } })
    expect(tokensOf(result!.launchCommand, 'posix')).toEqual([
      'claude',
      '--model',
      'claude-opus-4-8',
      '--effort',
      'max',
      '--resume',
      SESSION_ID,
      PROMPT
    ])
  })

  it('strips a stale selector in the base command and still ends with the prompt', () => {
    const result = plan({ agentCommand: `claude --resume OLD-ID --verbose` })
    expect(tokensOf(result!.launchCommand, 'posix')).toEqual([
      'claude',
      '--verbose',
      '--resume',
      SESSION_ID,
      PROMPT
    ])
  })

  for (const shell of ['posix', 'powershell', 'cmd'] as AgentStartupShell[]) {
    it(`is the last literal token under ${shell} quoting, and the rest is unchanged`, () => {
      const platform = shell === 'posix' ? 'linux' : 'win32'
      const withPrompt = plan({ platform, shell })
      const without = plan({ platform, shell }, null)
      expect(tokensOf(withPrompt!.launchCommand, shell).at(-1)).toBe(PROMPT)
      expect(withPrompt!.launchCommand).toBe(
        `${without!.launchCommand} ${quoteStartupArg(PROMPT, shell)}`
      )
    })
  }

  it('never puts the prompt into the persisted launch config', () => {
    const result = plan({ agentCommand: 'claude --verbose' })
    expect(JSON.stringify(result!.launchConfig)).not.toContain('re-anchor')
    expect(result!.launchConfig.agentCommand).toBe('claude --verbose')
  })

  it('omits the prompt for a wrapper whose claude token cannot be located', () => {
    const wrapped = plan({ agentCommand: 'bash -c claude' })
    const wrappedWithout = plan({ agentCommand: 'bash -c claude' }, null)
    expect(wrapped!.launchCommand).toBe(wrappedWithout!.launchCommand)
    expect(wrapped!.launchCommand).not.toContain('re-anchor')
  })

  it("omits the prompt when claude's own -- terminator would put it in positional territory", () => {
    const result = plan({ agentCommand: 'claude -- some-positional' })
    expect(result!.launchCommand).not.toContain('re-anchor')
  })

  it('omits the prompt for any agent but claude', () => {
    const codex = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'codex-1' },
      cmdOverrides: {},
      platform: 'linux',
      resumePrompt: PROMPT
    })
    const codexWithout = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'codex-1' },
      cmdOverrides: {},
      platform: 'linux'
    })
    expect(codex?.launchCommand).toBe(codexWithout?.launchCommand)
  })

  it('is byte-identical to today with no resumePrompt', () => {
    expect(plan({}, null)?.launchCommand).toBe(`claude '--resume' '${SESSION_ID}'`)
    expect(plan({}, '')?.launchCommand).toBe(`claude '--resume' '${SESSION_ID}'`)
    expect(
      buildAgentResumeLaunchCommand('claude', 'claude', ['claude', '--resume', 'X'], 'posix')
    ).toBe(`claude '--resume' 'X'`)
  })
})
