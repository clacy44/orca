import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { DAEMON_DEATH_REANCHOR_PROMPT } from '../../../../shared/daemon-death-reanchor-prompt'
import { reanchorResumePrompt } from './daemon-death-reanchor'

function record(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live',
    ...overrides
  }
}

describe('reanchorResumePrompt (R315 S2)', () => {
  it('yields the prompt only for a flagged claude record on the recovery relaunch', () => {
    for (const origin of ['live', 'daemon-death'] as const) {
      expect(
        reanchorResumePrompt('claude', record({ origin, reanchorAfterDaemonDeath: true }), true)
      ).toBe(DAEMON_DEATH_REANCHOR_PROMPT)
    }
  })

  it('yields none when the launch is not the recovery relaunch, even with a stale flag', () => {
    expect(
      reanchorResumePrompt('claude', record({ reanchorAfterDaemonDeath: true }), false)
    ).toBeNull()
  })

  it('yields none without the flag, even on the recovery relaunch', () => {
    expect(reanchorResumePrompt('claude', record(), true)).toBeNull()
    expect(
      reanchorResumePrompt('claude', record({ reanchorAfterDaemonDeath: false }), true)
    ).toBeNull()
  })

  it('yields none for quit, worktree-sleep or origin-less records, even if flagged', () => {
    for (const origin of ['quit', 'worktree-sleep', undefined] as const) {
      expect(
        reanchorResumePrompt('claude', record({ origin, reanchorAfterDaemonDeath: true }), true)
      ).toBeNull()
    }
  })

  it('yields none with no record, or for any agent but claude', () => {
    expect(reanchorResumePrompt('claude', undefined, true)).toBeNull()
    expect(
      reanchorResumePrompt(
        'codex',
        record({ agent: 'codex', reanchorAfterDaemonDeath: true }),
        true
      )
    ).toBeNull()
    expect(
      reanchorResumePrompt(undefined, record({ reanchorAfterDaemonDeath: true }), true)
    ).toBeNull()
  })
})
