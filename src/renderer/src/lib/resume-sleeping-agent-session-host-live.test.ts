// A live local terminal in main's inventory still runs the conversation a sleeping record names;
// no wake path may start a second `--resume` of it, and the record must stay uncleared.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { LiveAgentSessionMark } from '../../../shared/sweep-restore-mark-list'
import { useAppStore } from '@/store'
import { applySweepRestoreMarkListReply } from '@/startup/sweep-restore-marks-hydration'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { launchSleepingAgentSession } from './sleeping-agent-session-launch'

useAppStore.setState({ sweepRestoreMarksHydrated: true })
const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'quit',
    ...overrides
  }
}

function makeTerminalTab(id: string, worktreeId: string): Record<string, unknown> {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function seed(record: SleepingAgentSessionRecord, live: LiveAgentSessionMark[]): void {
  useAppStore.setState({
    tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record },
    sweepRestoredPaneKeys: new Set<string>()
  } as never)
  applySweepRestoreMarkListReply({ paneKeys: [], liveAgentSessions: live })
}

describe('sleeping-agent wake against live terminals', () => {
  it('skips a record whose pane key a live terminal holds, without clearing it', () => {
    const record = makeRecord()
    seed(record, [
      {
        ptyId: 'pty-live',
        paneKey: record.paneKey,
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSessionId: 'other'
      }
    ])

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(launchSleepingAgentSession(record)).toBe(false)

    const state = useAppStore.getState()
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
  })

  it('skips a record whose session a live terminal holds under another pane key, without clearing it', () => {
    const record = makeRecord()
    seed(record, [
      {
        ptyId: 'pty-9',
        paneKey: 'tab-9:leaf-9',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSessionId: record.providerSession.id
      }
    ])

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(launchSleepingAgentSession(record)).toBe(false)

    const state = useAppStore.getState()
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
  })

  it('does not treat the same session id in another worktree or agent as held', () => {
    const record = makeRecord()
    seed(record, [
      {
        ptyId: 'pty-9',
        paneKey: 'tab-9:leaf-9',
        worktreeId: 'wt-2',
        agent: 'claude',
        providerSessionId: record.providerSession.id
      },
      {
        ptyId: 'pty-8',
        paneKey: 'tab-8:leaf-8',
        worktreeId: 'wt-1',
        agent: 'codex',
        providerSessionId: record.providerSession.id
      }
    ])

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
  })

  it('positive control: a record no live terminal holds still launches and is cleared', () => {
    const record = makeRecord()
    seed(record, [])

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)

    const state = useAppStore.getState()
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
    // createTab ran: the wake started a resume tab (the old unbound shell tab was swept as an orphan).
    expect(state.tabsByWorktree['wt-1']?.some((tab) => tab.id !== 'tab-1')).toBe(true)
  })

  it('replaces the live sets on every reply, so a conversation that left the inventory resumes again', () => {
    const record = makeRecord()
    seed(record, [
      {
        ptyId: 'pty-live',
        paneKey: record.paneKey,
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSessionId: 'x'
      }
    ])
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)

    applySweepRestoreMarkListReply({ paneKeys: [], liveAgentSessions: [] })

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
  })

  it('keeps the marks it holds when a reply omits the field (live set unknown)', () => {
    const record = makeRecord()
    seed(record, [
      {
        ptyId: 'pty-live',
        paneKey: record.paneKey,
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSessionId: 'x'
      }
    ])

    applySweepRestoreMarkListReply({ paneKeys: [] })

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })
})
