import { describe, expect, it } from 'vitest'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import type { RetainedAgentEntry } from './agent-status'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

// Why: a "done" row survives its tab closing so the result isn't lost unseen —
// only an explicit user close is the acknowledgment; lifecycle/programmatic
// closes (pty-exit, cleanup) must leave the retained snapshot standing.

const WORKTREE_ID = 'repo::/repo/worktree'
const TAB_ID = 'tab-a'
const PANE_KEY = `${TAB_ID}:leaf-1`

function seedRetainedDoneAgent(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo', path: '/repo/worktree' })]
    },
    tabsByWorktree: { [WORKTREE_ID]: [makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID })] }
  })
  const entry: AgentStatusEntry = {
    state: 'done',
    prompt: 'Fix it',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude',
    interrupted: false
  }
  const retained: RetainedAgentEntry = {
    entry,
    worktreeId: WORKTREE_ID,
    tab: makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID }),
    agentType: 'claude',
    startedAt: 1
  }
  store.setState({ retainedAgentsByPaneKey: { [PANE_KEY]: retained } })
}

describe('dropAgentStatusByTabPrefix retained-snapshot handling', () => {
  it('drops the retained snapshot by default', () => {
    const store = createTestStore()
    seedRetainedDoneAgent(store)

    store.getState().dropAgentStatusByTabPrefix(TAB_ID)

    expect(store.getState().retainedAgentsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('keeps the retained snapshot when preserveRetainedSnapshot is set', () => {
    const store = createTestStore()
    seedRetainedDoneAgent(store)

    store.getState().dropAgentStatusByTabPrefix(TAB_ID, { preserveRetainedSnapshot: true })

    expect(store.getState().retainedAgentsByPaneKey[PANE_KEY]).toBeDefined()
  })
})

describe('closeTab reason gates retained-snapshot dismissal', () => {
  it('a user-initiated close dismisses the retained snapshot for that tab', () => {
    const store = createTestStore()
    seedRetainedDoneAgent(store)

    store.getState().closeTab(TAB_ID, { reason: 'user' })

    expect(store.getState().retainedAgentsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('closeTab with no explicit reason defaults to user and dismisses the snapshot', () => {
    const store = createTestStore()
    seedRetainedDoneAgent(store)

    store.getState().closeTab(TAB_ID)

    expect(store.getState().retainedAgentsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('a pty-exit close preserves the retained snapshot', () => {
    const store = createTestStore()
    seedRetainedDoneAgent(store)

    store.getState().closeTab(TAB_ID, { reason: 'pty-exit' })

    expect(store.getState().retainedAgentsByPaneKey[PANE_KEY]).toBeDefined()
  })

  it('a cleanup close preserves the retained snapshot', () => {
    const store = createTestStore()
    seedRetainedDoneAgent(store)

    store.getState().closeTab(TAB_ID, { reason: 'cleanup' })

    expect(store.getState().retainedAgentsByPaneKey[PANE_KEY]).toBeDefined()
  })
})
