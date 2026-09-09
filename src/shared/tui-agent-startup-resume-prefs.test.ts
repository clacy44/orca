// [S10-21d R118, design (c)] buildAgentResumeStartupPlan used to accept `sessionOptions` and
// silently drop it (diag-r118-2026-09-08.md) — a resumed Claude session takes the config-dir
// default, not what the pane last ran with, so nothing ever re-applied the pane's stored prefs.
// This file locks the fix: sessionOptions now flows into the launch command exactly as the
// create path (buildAgentStartupPlan) already does, and NULL sessionOptions stays byte-identical.
import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'

const SESSION_ID = 'claude-session-resume-prefs-1'
const providerSession = { key: 'session_id', id: SESSION_ID } as const

describe('buildAgentResumeStartupPlan: sessionOptions (S10-21d R118)', () => {
  it('NULL sessionOptions leaves the resume argv byte-identical to today', () => {
    const withUndefined = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession,
      cmdOverrides: {},
      platform: 'linux'
    })
    const withEmpty = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession,
      cmdOverrides: {},
      sessionOptions: {},
      platform: 'linux'
    })
    expect(withUndefined?.launchCommand).toBe(withEmpty?.launchCommand)
    expect(withUndefined?.launchCommand).not.toContain('--model')
    expect(withUndefined?.launchCommand).not.toContain('--effort')
    expect(withUndefined?.launchCommand).toBe(`claude '--resume' '${SESSION_ID}'`)
  })

  it('prefs -> argv carries --model X --effort max, launchConfig keeps commandWithoutSessionOptions', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession,
      cmdOverrides: {},
      sessionOptions: { model: 'claude-opus-4-8', effort: 'max' },
      platform: 'linux'
    })
    expect(plan?.launchCommand).toBe(
      `claude '--model' 'claude-opus-4-8' '--effort' 'max' '--resume' '${SESSION_ID}'`
    )
    // Why: a resumed session's picker flags must not be folded into the persisted launchConfig
    // (design (c)) — the NEXT restore re-derives them fresh from the stored launch row instead.
    expect(plan?.launchConfig.agentCommand).toBe('claude')
  })

  it('prefs -> argv carries --effort ultracode verbatim', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession,
      cmdOverrides: {},
      sessionOptions: { effort: 'ultracode' },
      platform: 'linux'
    })
    expect(plan?.launchCommand).toBe(`claude '--effort' 'ultracode' '--resume' '${SESSION_ID}'`)
  })

  it('a caller-supplied agentCommand with a stale --effort is replaced by the current sessionOptions', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession,
      cmdOverrides: {},
      agentCommand: 'claude --effort high',
      sessionOptions: { effort: 'max' },
      platform: 'linux'
    })
    const effortCount = (plan?.launchCommand.match(/--effort/g) ?? []).length
    expect(effortCount).toBe(1)
    expect(plan?.launchCommand).not.toContain('high')
    expect(plan?.launchCommand).toContain('max')
  })

  it('Windows/PowerShell: the two flags survive tokenization round-trip', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession,
      cmdOverrides: {},
      sessionOptions: { model: 'claude opus', effort: 'max' },
      platform: 'win32',
      shell: 'powershell'
    })
    expect(plan?.launchCommand).toBeTruthy()
    expect(plan?.launchCommand).toContain('--model')
    expect(plan?.launchCommand).toContain('--effort')
    expect(plan?.launchCommand).toContain('claude opus')
  })
})
