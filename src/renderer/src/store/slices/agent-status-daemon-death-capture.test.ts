// S10-21a C7g (Ruling 34 Addendum 25): `origin: 'daemon-death'` must NOT get 'quit''s
// periodic-checkpoint precedence — split out of agent-status-quit-capture.test.ts to stay under
// the 800-line test cap.
import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

describe('S10-21a C7g: captureSleepingAgentSessionForDaemonDeath / quit precedence exclusion', () => {
  it('captureSleepingAgentSessionForDaemonDeath tags the record origin "daemon-death"', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      },
      agentStatusByPaneKey: {
        'tab-1:leaf-1': {
          state: 'working',
          prompt: 'first task',
          updatedAt: 10,
          stateStartedAt: 10,
          stateHistory: [],
          agentType: 'codex',
          paneKey: 'tab-1:leaf-1',
          worktreeId: 'wt-1',
          providerSession: { key: 'session_id', id: 'codex-session-1' }
        }
      }
      // No pre-existing sleepingAgentSessionsByPaneKey entry — mirrors the real call site
      // (terminal-pane-recovery.ts, BEFORE the remount): a live-only pane, nothing captured yet.
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionForDaemonDeath('tab-1:leaf-1')
    const daemonDeathRecord = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
    expect(daemonDeathRecord).toMatchObject({
      origin: 'daemon-death',
      providerSession: { key: 'session_id', id: 'codex-session-1' }
    })
  })

  it('lets a periodic checkpoint supersede a daemon-death record (unlike quit)', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const providerSession = { key: 'session_id' as const, id: 'codex-session-1' }
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'first task', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )
    // Why not captureSleepingAgentSessionForDaemonDeath here: `setAgentStatus` above already
    // populated an `origin: 'live'` provisional checkpoint for this resumable provider session
    // (setAgentStatus's own "liveRecoveryRecord" mechanic), and the capture action is
    // deliberately idempotent against ANY existing record — origin included — for this pane.
    // Patching the origin directly isolates the property under test (periodic-mode precedence)
    // from that unrelated overwrite guard.
    const liveRecord = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        ...store.getState().sleepingAgentSessionsByPaneKey,
        'tab-1:leaf-1': { ...liveRecord, origin: 'daemon-death' }
      }
    } as Partial<AppState>)
    const daemonDeathRecord = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
    expect(daemonDeathRecord).toMatchObject({ origin: 'daemon-death', providerSession })

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'new task', agentType: 'codex' },
        'Codex',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: { key: 'session_id', id: 'codex-session-2' } }
      )
    store.getState().captureAllSleepingAgentSessions('periodic')

    // Unlike the quit case (agent-status-quit-capture.test.ts), the periodic checkpoint DID
    // supersede the daemon-death record.
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).not.toBe(
      daemonDeathRecord
    )
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      origin: 'live',
      providerSession: { key: 'session_id', id: 'codex-session-2' }
    })
  })
})
