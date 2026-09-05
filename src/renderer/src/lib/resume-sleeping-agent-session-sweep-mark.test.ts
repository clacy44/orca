// S10-21a C7c, T32: the main-process sweep's double-resume-prevention mark, renderer half.
// Kept as its own file (not appended to resume-sleeping-agent-session.test.ts) — that file is
// already at its max-lines ratchet ceiling.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

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

describe('resumeSleepingAgentSessionsForWorktree: sweep restore marks (T32)', () => {
  it('never resumes a sweep-marked pane, and the mark survives an unrelated store round-trip', () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record },
      sweepRestoredPaneKeys: new Set([record.paneKey])
    } as never)
    // Simulate the renderer racing an UNRELATED workspace-session round-trip: the mark lives in
    // `sweepRestoredPaneKeys`, never in `WorkspaceSessionState`, so a session:set-shaped mutation
    // elsewhere in the store cannot touch it.
    useAppStore.setState({ tabBarOrderByWorktree: { 'wt-1': ['tab-1'] } } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    const state = useAppStore.getState()
    // The record is left in place (not cleared) — it is simply never acted on again.
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
    expect(state.tabsByWorktree['wt-1']?.length).toBe(1)
    expect(state.sweepRestoredPaneKeys.has(record.paneKey)).toBe(true)
  })

  it('resumes normally once the pane is unmarked (baseline, no regression)', () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record },
      sweepRestoredPaneKeys: new Set<string>()
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })
})
