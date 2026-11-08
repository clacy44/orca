// A pty born after startup (a restored chair, a background worker) is tab-less in the renderer, so
// the startup-only live-session marks never name it and a later resume pass would open a second tab
// for its conversation. Main pushes fresh marks after such a pty appears; useIpcEvents applies them.
import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { LiveAgentSessionMark } from '../../../shared/sweep-restore-mark-list'
import { deriveLiveAgentSessionState } from '@/lib/live-agent-session-guard'
import { createHarnessStoreState, type HarnessStoreState } from './ipc-events-test-harness'
import { loadIpcEventsHarnessWithLiveSessionPush } from './ipc-events-live-session-push-harness'

const WORKTREE = 'wt-1'
const PANE_KEY = 'tab-chair:11111111-1111-4111-8111-111111111111'
const SESSION = 'sess-chair-1'

const RECORD: SleepingAgentSessionRecord = {
  paneKey: PANE_KEY,
  tabId: 'tab-chair',
  worktreeId: WORKTREE,
  agent: 'claude',
  providerSession: { key: 'session_id', id: SESSION },
  prompt: '',
  state: 'working',
  capturedAt: 1,
  updatedAt: 1,
  origin: 'live'
}

const MARK: LiveAgentSessionMark = {
  ptyId: 'pty-chair',
  paneKey: PANE_KEY,
  worktreeId: WORKTREE,
  agent: 'claude',
  providerSessionId: SESSION
}

function tablessStoreState(): HarnessStoreState {
  const state: HarnessStoreState = createHarnessStoreState({
    tabsByWorktree: { [WORKTREE]: [] },
    sweepRestoreMarksHydrated: true,
    sweepRestoredPaneKeys: new Set<string>(),
    sleepingAgentSessionsByPaneKey: { [PANE_KEY]: RECORD },
    agentStatusByPaneKey: {},
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    ...deriveLiveAgentSessionState({}),
    clearSleepingAgentSession: vi.fn(),
    notePendingSweepMarksResumeWorktreeId: vi.fn(),
    workspaceSessionReady: false
  })
  // Same replace-the-set behaviour as the real store's setLiveAgentSessions.
  state.setLiveAgentSessions = vi.fn((marks: readonly LiveAgentSessionMark[]) => {
    const byPtyId: Record<string, LiveAgentSessionMark[]> = {}
    for (const mark of marks) {
      ;(byPtyId[mark.ptyId] ??= []).push(mark)
    }
    Object.assign(state, deriveLiveAgentSessionState(byPtyId))
  })
  return state
}

describe('live agent-session push into the renderer', () => {
  it('a pushed mark for a tab-less pane stops the resume pass from opening a second tab', async () => {
    const storeState = tablessStoreState()
    const harness = await loadIpcEventsHarnessWithLiveSessionPush(storeState)
    harness.useIpcEvents()
    const { resumeSleepingAgentSessionsForWorktree } =
      await import('@/lib/resume-sleeping-agent-session')

    harness.pushLiveAgentSessions([MARK])

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE)).toBe(0)
    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(storeState.clearSleepingAgentSession).not.toHaveBeenCalled()
    expect(storeState.sleepingAgentSessionsByPaneKey).toEqual({ [PANE_KEY]: RECORD })
  })

  it('ignores a malformed push', async () => {
    const storeState = tablessStoreState()
    const harness = await loadIpcEventsHarnessWithLiveSessionPush(storeState)
    harness.useIpcEvents()

    harness.pushLiveAgentSessions(null)

    expect(storeState.setLiveAgentSessions).not.toHaveBeenCalled()
  })
})
