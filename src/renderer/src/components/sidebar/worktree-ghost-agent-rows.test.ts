import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

const WORKTREE_ID = 'wt-1'
const NOW = 1_000_000

function makeTab(id: string, title: string): TerminalTab {
  return {
    id,
    worktreeId: WORKTREE_ID,
    ptyId: 'pty-1',
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeEntry(
  tabId: string,
  leafId: string,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    paneKey: makePaneKey(tabId, leafId),
    state: 'working',
    prompt: 'do the thing',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'claude',
    worktreeId: WORKTREE_ID,
    terminalTitle: 'Orca fork orchestration resilience and shared presence',
    ...overrides
  }
}

describe('buildWorktreeAgentRows — resumed-session ghost rows (STA-3107-adjacent)', () => {
  it('collapses three tabless, restoredUnconfirmed ghost entries sharing a live pane title to a single live row', () => {
    const liveTab = makeTab('tab-live', 'Orca fork orchestration resilience and shared presence')
    const live = makeEntry('tab-live', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    const ghost1 = makeEntry('tab-ghost-1', '11111111-1111-4111-8111-111111111111', {
      restoredUnconfirmed: true,
      updatedAt: NOW - 60_000,
      stateStartedAt: NOW - 3 * 24 * 60 * 60 * 1000
    })
    const ghost2 = makeEntry('tab-ghost-2', '22222222-2222-4222-8222-222222222222', {
      restoredUnconfirmed: true,
      updatedAt: NOW - 60_000,
      stateStartedAt: NOW - 2 * 24 * 60 * 60 * 1000
    })
    const ghost3 = makeEntry('tab-ghost-3', '33333333-3333-4333-8333-333333333333', {
      restoredUnconfirmed: true,
      updatedAt: NOW - 60_000,
      stateStartedAt: NOW - 1 * 24 * 60 * 60 * 1000
    })

    const rows = buildWorktreeAgentRows({
      tabs: [liveTab],
      entries: [live, ghost1, ghost2, ghost3],
      retained: [],
      now: NOW
    })

    const nonSubagentRows = rows.filter((row) => row.rowSource !== 'retained' || true)
    expect(nonSubagentRows.map((row) => row.paneKey)).toEqual([live.paneKey])
  })

  it('drops a tabless entry that is merely stale (not restoredUnconfirmed) and has no live orchestration parent', () => {
    const staleGhost = makeEntry('tab-stale', '44444444-4444-4444-8444-444444444444', {
      updatedAt: NOW - 60 * 60 * 1000 // 1h stale, past AGENT_STATUS_STALE_AFTER_MS
    })

    const rows = buildWorktreeAgentRows({
      tabs: [],
      entries: [staleGhost],
      retained: [],
      now: NOW
    })

    expect(rows).toHaveLength(0)
  })

  it('keeps a tabless entry whose orchestration parent pane is a currently open tab', () => {
    const parentLeafId = '55555555-5555-4555-8555-555555555555'
    const parentTab = makeTab('tab-parent', 'Parent agent')
    const parentEntry = makeEntry('tab-parent', parentLeafId)
    const workerNoTabYet = makeEntry('tab-worker', '66666666-6666-4666-8666-666666666666', {
      updatedAt: NOW - 60 * 60 * 1000,
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'dispatch-1',
        parentPaneKey: makePaneKey('tab-parent', parentLeafId)
      }
    })

    const rows = buildWorktreeAgentRows({
      tabs: [parentTab],
      entries: [parentEntry, workerNoTabYet],
      retained: [],
      now: NOW
    })

    expect(rows.map((row) => row.paneKey)).toContain(workerNoTabYet.paneKey)
  })
})
