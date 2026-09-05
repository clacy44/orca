// S10-21a C15 (R52, chair revision): no sleeping-agent resume decision may run before the
// renderer's post-sweep marks have hydrated — `resumeSleepingAgentSessionsForWorktree` defers
// entirely (no createTab, no spawn, no override) and queues the worktree id for a one-time
// replay once hydration completes.
import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
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

describe('resumeSleepingAgentSessionsForWorktree: marks-hydration gate (S10-21a C15, R52)', () => {
  it('(a) defers before hydration — no createTab, the worktree is queued for replay', () => {
    const record = makeRecord()
    useAppStore.setState({
      sweepRestoreMarksHydrated: false,
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const result = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(result).toBe('deferred_marks_pending')
    const state = useAppStore.getState()
    // Untouched — no createTab, no spawn, no override decision was ever reached.
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
    expect(state.tabsByWorktree['wt-1']?.length).toBe(1)
    expect(state.pendingSweepMarksResumeWorktreeIds.has('wt-1')).toBe(true)
  })

  it('(b)+(c) replay after hydration resumes the unmarked pane but never the sweep-marked one, exactly once', () => {
    const marked = makeRecord({ paneKey: 'tab-1:leaf-1', tabId: 'tab-1' })
    const unmarked = makeRecord({
      paneKey: 'tab-2:leaf-1',
      tabId: 'tab-2',
      providerSession: { key: 'session_id', id: 'sess-2' }
    })
    useAppStore.setState({
      sweepRestoreMarksHydrated: false,
      tabsByWorktree: {
        'wt-1': [makeTerminalTab('tab-1', 'wt-1'), makeTerminalTab('tab-2', 'wt-1')]
      },
      sleepingAgentSessionsByPaneKey: {
        [marked.paneKey]: marked,
        [unmarked.paneKey]: unmarked
      }
    } as never)

    // Both records arrive while unhydrated — the whole worktree is deferred, not resumed.
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe('deferred_marks_pending')

    // Hydration completes: App.tsx applies the post-sweep marks, flips the flag, then replays
    // every queued worktree exactly once.
    useAppStore.getState().setSweepRestoredPaneKeys([marked.paneKey])
    useAppStore.getState().setSweepRestoreMarksHydrated(true)
    const pending = useAppStore.getState().takePendingSweepMarksResumeWorktreeIds()
    expect(pending).toEqual(['wt-1'])
    // The take already drained the set — a second take proves the "exactly once" replay bound.
    expect(useAppStore.getState().takePendingSweepMarksResumeWorktreeIds()).toEqual([])

    const replayed = pending.map((worktreeId) => resumeSleepingAgentSessionsForWorktree(worktreeId))

    expect(replayed).toEqual([1])
    const state = useAppStore.getState()
    // (c) fence: the unmarked pane still resumes normally once marks are trustworthy.
    expect(state.sleepingAgentSessionsByPaneKey[unmarked.paneKey]).toBeUndefined()
    // The sweep-marked pane is never resumed here — the sweep already restored it.
    expect(state.sleepingAgentSessionsByPaneKey[marked.paneKey]).toBe(marked)
  })
})
