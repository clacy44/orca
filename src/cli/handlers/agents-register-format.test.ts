// F-19 B2 (Ruling 33(a)): register wakes the pane for ANY unread mail on the landed id, not
// just what its own repoint just moved — this proves the CLI line renders when unreadWaiting > 0
// and stays silent when it is 0.
import { describe, expect, it } from 'vitest'
import { formatAgentRegister, type RegisterResult } from './agents-register-format'
import type { AgentView } from './agents'

function baseResult(overrides: Partial<RegisterResult> = {}): RegisterResult {
  const agent: AgentView = {
    id: 'agt_abc123',
    displayName: 'chair',
    role: null,
    host: 'local',
    state: 'idle',
    derived: false,
    quarantined: false,
    title: null,
    branch: null,
    worktreePath: null
  }
  return {
    agent,
    created: false,
    reMinted: true,
    repointedMessages: 0,
    pendingOnOldHandle: 0,
    adoptedThreads: 0,
    blockedByQuarantinedPredecessor: false,
    pendingPeerQuestions: 0,
    unreadMailOnRetiredId: 0,
    unreadWaiting: 0,
    ...overrides
  }
}

describe('formatAgentRegister: unreadWaiting (Ruling 33(a) B2)', () => {
  it('prints one line when unreadWaiting > 0', () => {
    const text = formatAgentRegister(baseResult({ unreadWaiting: 3 }))
    expect(text).toContain('3 unread message(s) waiting — run: orca orchestration check')
  })

  it('prints nothing when unreadWaiting is 0', () => {
    const text = formatAgentRegister(baseResult({ unreadWaiting: 0 }))
    expect(text).not.toContain('unread message(s) waiting')
  })
})
