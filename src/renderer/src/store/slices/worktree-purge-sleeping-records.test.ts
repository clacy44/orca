// 10z.5 R288 (T15): the authoritative worktree purge drops orphaned saved-session records (tab
// already closed) of a purged worktree, with their launch configs; other worktrees' records stay.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

const mockApi = {
  worktrees: { list: vi.fn().mockResolvedValue([]), remove: vi.fn().mockResolvedValue(undefined) },
  pty: { kill: vi.fn().mockResolvedValue(undefined) }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore, makeWorktree } from './store-test-helpers'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'

const WT1 = 'repo1::/path/wt1'
const WT2 = 'repo1::/path/wt2'
const PANE_WT1 = 'closed-tab-1:11111111-1111-4111-8111-111111111111'
const PANE_WT1_KEY_FORM = 'closed-tab-2:22222222-2222-4222-8222-222222222222'
const PANE_WT2 = 'closed-tab-3:33333333-3333-4333-8333-333333333333'

function record(paneKey: string, worktreeId: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: `session-${paneKey}` },
    prompt: 'p',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1
  } as SleepingAgentSessionRecord
}

const launchConfig = { agentCommand: 'claude' } as never

describe('worktree purge drops orphaned sleeping-agent records', () => {
  beforeEach(() => vi.clearAllMocks())

  function seed() {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: WT2, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      // No tab of either worktree is open: the records are orphaned.
      tabsByWorktree: {},
      sleepingAgentSessionsByPaneKey: {
        [PANE_WT1]: record(PANE_WT1, WT1),
        [PANE_WT1_KEY_FORM]: record(PANE_WT1_KEY_FORM, worktreeWorkspaceKey(WT1)),
        [PANE_WT2]: record(PANE_WT2, WT2)
      },
      agentLaunchConfigByPaneKey: {
        [PANE_WT1]: launchConfig,
        [PANE_WT1_KEY_FORM]: launchConfig,
        [PANE_WT2]: launchConfig
      }
    })
    return store
  }

  it('drops the purged worktree records (raw id and workspace-key form) with their launch configs', () => {
    const store = seed()
    store.getState().purgeWorktreeTerminalState([WT1])
    const s = store.getState()
    expect(s.sleepingAgentSessionsByPaneKey[PANE_WT1]).toBeUndefined()
    expect(s.sleepingAgentSessionsByPaneKey[PANE_WT1_KEY_FORM]).toBeUndefined()
    expect(s.agentLaunchConfigByPaneKey[PANE_WT1]).toBeUndefined()
    expect(s.agentLaunchConfigByPaneKey[PANE_WT1_KEY_FORM]).toBeUndefined()
  })

  it('keeps other worktrees records and their launch configs', () => {
    const store = seed()
    store.getState().purgeWorktreeTerminalState([WT1])
    const s = store.getState()
    expect(s.sleepingAgentSessionsByPaneKey[PANE_WT2]?.worktreeId).toBe(WT2)
    expect(s.agentLaunchConfigByPaneKey[PANE_WT2]).toBe(launchConfig)
  })
})
