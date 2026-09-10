import { describe, expect, it } from 'vitest'
import {
  buildAgentDraftLaunchPlan,
  buildAgentResumeStartupPlan,
  buildAgentStartupPlan
} from './tui-agent-startup'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

describe('tui agent startup session options', () => {
  it('emits catalog options before user arguments without recording an overridden model', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'opus', effort: 'xhigh', fastMode: true },
      agentArgs: '--model haiku'
    })
    expect(plan?.launchCommand).toBe("claude '--model' 'opus' '--effort' 'xhigh' '--model' 'haiku'")
    expect(plan?.sessionOptions).toBeUndefined()
  })

  it('keeps the model record but drops an effort overridden by user arguments', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'opus', effort: 'xhigh' },
      agentArgs: '--effort low'
    })
    expect(plan?.sessionOptions).toEqual({ model: 'opus' })
  })

  it('lets explicit worker preferences override general agent arguments', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'custom-codex-model', effort: 'high' },
      sessionOptionsOverrideAgentArgs: true,
      agentArgs: '-m gpt-5.5 -c model_reasoning_effort=low'
    })
    expect(plan?.launchCommand).toBe(
      "codex '-m' 'custom-codex-model' '-c' 'model_reasoning_effort=high'"
    )
    expect(plan?.launchConfig.agentCommand).toBe(
      "codex '-m' 'gpt-5.5' '-c' 'model_reasoning_effort=low'"
    )
    expect(plan?.sessionOptions).toEqual({ model: 'custom-codex-model', effort: 'high' })
  })

  it('inserts worker preferences before an argument terminator', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'custom-codex-model', effort: 'high' },
      sessionOptionsOverrideAgentArgs: true,
      agentArgs: '--dangerously-bypass-approvals-and-sandbox -- literal'
    })
    expect(plan?.launchCommand).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox' '-m' 'custom-codex-model' '-c' 'model_reasoning_effort=high' '--' 'literal'"
    )
  })

  it('rejects conflicting singleton flags in an agent command override', () => {
    expect(
      resolveAgentLaunchCommand({
        agent: 'codex',
        cmdOverrides: { codex: 'codex --profile work -m gpt-5.5' },
        platform: 'linux',
        shell: 'posix',
        sessionOptions: { model: 'custom-codex-model', effort: 'high' },
        sessionOptionsOverrideAgentArgs: true
      })
    ).toEqual({
      ok: false,
      error:
        'Agent command override conflicts with the requested launch preferences. Remove model or effort flags from the command override.'
    })
  })

  it('recognizes a long Codex model flag overriding the generated short flag', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'gpt-5.6-sol', effort: 'medium' },
      agentArgs: '--model gpt-5.5'
    })
    expect(plan?.sessionOptions).toBeUndefined()
  })

  it('keeps one-time picker flags out of the command captured for resume', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'gpt-5.6-sol', effort: 'medium' },
      agentArgs: '--dangerously-bypass-approvals-and-sandbox'
    })
    expect(plan?.launchConfig.agentCommand).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox'"
    )
  })

  it('quotes option values for a remote POSIX launch', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      isRemote: true,
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: "team's-model", effort: 'high' }
    })
    expect(plan?.launchCommand).toContain("'team'\\''s-model'")
  })

  it('threads options through native draft launches', () => {
    const plan = buildAgentDraftLaunchPlan({
      agent: 'claude',
      draft: 'review this',
      cmdOverrides: {},
      platform: 'linux',
      sessionOptions: { model: 'opus', effort: 'high' }
    })
    expect(plan?.launchCommand).toContain("claude '--model' 'opus' '--effort' 'high'")
    expect(plan?.sessionOptions).toEqual({ model: 'opus', effort: 'high' })
  })

  // [S10-21d R118, SCENARIO_CORRECTION] This scenario used to be "never injects session options
  // into resume commands", asserting the exact defect R118 fixes: buildAgentResumeStartupPlan
  // accepted `sessionOptions` and silently dropped them on every resumable agent, not only
  // claude (diag-r118-2026-09-08.md — the root cause named this function, not a claude-specific
  // branch of it). Design (c) is explicit: sessionOptions now flows into resolveAgentLaunchCommand
  // "exactly as the create path" — agent-generic, so codex resuming with a stored model/effort
  // now carries them too, the same way it already did on a fresh create (the `never injects`
  // premise was the bug this whole brief exists to remove).
  it('injects session options into resume commands, same as create (S10-21d R118)', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'thread-1' },
      cmdOverrides: {},
      platform: 'linux',
      sessionOptions: { model: 'gpt-5.5', effort: 'high' }
    })
    expect(plan?.launchCommand).toBe(
      "codex '-m' 'gpt-5.5' '-c' 'model_reasoning_effort=high' 'resume' 'thread-1'"
    )
    expect(plan?.sessionOptions).toEqual({ model: 'gpt-5.5', effort: 'high' })
  })

  // [D-R170 H1 regression] Before the fix, sessionOptionsOverrideAgentArgs was
  // `Boolean(args.sessionOptions)` unconditionally, which armed the override-conflict refusal
  // in resolveAgentLaunchCommand whenever a cold-restore pane carried BOTH a stored preference
  // and an operator agentCmdOverrides entry mentioning --model/--effort — even when the two
  // agreed exactly. buildAgentResumeStartupPlan returned null, and the caller
  // (ensureAgentSession) threw 'agent_session_identity_required', so the pane never came back.
  // Pre-fix behaviour: `plan` was `null` and the production caller surfaced
  // 'agent_session_identity_required' instead of resuming.
  it('resumes when a cmdOverride and a matching sessionOptions preference agree (D-R170 H1)', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-1' },
      cmdOverrides: { claude: 'claude --model x' },
      platform: 'linux',
      sessionOptions: { model: 'pref' }
    })
    expect(plan).not.toBeNull()
    expect(plan?.launchCommand).toBe("claude '--model' 'pref' '--resume' 'sess-1'")
  })

  // [D-R170 M-B7c] A model-only preference on resume must not silently drop the catalog's
  // default effort (M16). State the defaults explicitly: claude's catalog default effort is
  // 'high' (agent-session-option-catalog-claude-codex.ts:81-83).
  it('still injects the catalog default effort for a model-only preference on resume (D-R170 M-B7c)', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-1' },
      cmdOverrides: {},
      platform: 'linux',
      sessionOptions: { model: 'opus' }
    })
    expect(plan?.launchCommand).toBe(
      "claude '--effort' 'high' '--model' 'opus' '--resume' 'sess-1'"
    )
  })

  // [D-R170 M-B7d] Precedence: an operator-typed --model in agentArgs must not win over a
  // persisted sessionOptions preference on resume.
  it('lets a persisted model preference beat an operator --model in agentArgs on resume (D-R170 M-B7d)', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-1' },
      cmdOverrides: {},
      platform: 'linux',
      agentArgs: '--model operator-pin',
      sessionOptions: { model: 'pref-model' }
    })
    expect(plan?.launchCommand).toContain("'--model' 'pref-model'")
    expect(plan?.launchCommand).not.toContain('operator-pin')
  })

  // [D-R170 M-B7d] Second precedence variant: the same preference must still win when the
  // conflicting --model is authored via a command override rather than agentArgs — pinned to
  // the H1 resolution (a cmdOverride disarms sessionOptionsOverrideAgentArgs so the plan is
  // not refused, and buildAgentResumeLaunchCommand's own claude-resume splice still cuts the
  // override's --model token and replaces it with the preference).
  it('lets a persisted model preference beat a conflicting cmdOverride --model on resume (D-R170 M-B7d)', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-1' },
      cmdOverrides: { claude: 'claude --model operator-pin' },
      platform: 'linux',
      sessionOptions: { model: 'pref-model' }
    })
    expect(plan).not.toBeNull()
    expect(plan?.launchCommand).toBe("claude '--model' 'pref-model' '--resume' 'sess-1'")
  })

  // [D-R172 MEDIUM-3 fix, NH-1 revert pin] The create path with a catalog model plus a benign
  // override must launch. Before the D-R171 NH-1 fix (and if the reverted B7 edit (3) at
  // tui-agent-launch-command.ts:54 were ever re-applied), a picker preference naming a CATALOG
  // model id (one findCatalogModel actually resolves — 'sonnet', not an arbitrary string) with
  // no effort, plus ANY agentCmdOverrides entry at all, made resolveAgentLaunchCommand refuse
  // with "Agent command override conflicts with the requested launch preferences..." even
  // though the override here names neither model nor effort. No test in this file used a
  // catalog model id at a create call site (D-R171-g1-A2-review.md:62; D-R172-g1-A3-review.md
  // MEDIUM-3) — re-applying literal `true` at tui-agent-launch-command.ts:54 leaves every OTHER
  // test in this file green, so this is the one fixture that catches it.
  it('creates with a catalog model preference plus a benign command override (D-R172 MEDIUM-3, NH-1 revert pin)', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: { claude: 'claude --dangerously-skip-permissions' },
      platform: 'linux',
      sessionOptions: { model: 'sonnet' },
      sessionOptionsOverrideAgentArgs: true
    })
    expect(plan).not.toBeNull()
    expect(plan?.launchCommand).toContain('sonnet')
  })
})
