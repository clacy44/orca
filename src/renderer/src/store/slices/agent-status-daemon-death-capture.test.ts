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

  describe('R315: reanchorAfterDaemonDeath', () => {
    function storeWithLiveOnlyPane() {
      const store = createTestStore()
      store.setState({
        tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] },
        agentStatusByPaneKey: {
          'tab-1:leaf-1': {
            state: 'working',
            prompt: 'first task',
            updatedAt: 10,
            stateStartedAt: 10,
            stateHistory: [],
            agentType: 'claude',
            paneKey: 'tab-1:leaf-1',
            worktreeId: 'wt-1',
            providerSession: { key: 'session_id', id: 'claude-session-1' }
          }
        }
      } as Partial<AppState>)
      return store
    }

    it('sets the flag only when the capture asks for it', () => {
      const plain = storeWithLiveOnlyPane()
      plain.getState().captureSleepingAgentSessionForDaemonDeath('tab-1:leaf-1')
      expect(plain.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).not.toHaveProperty(
        'reanchorAfterDaemonDeath'
      )

      const notAsked = storeWithLiveOnlyPane()
      notAsked
        .getState()
        .captureSleepingAgentSessionForDaemonDeath('tab-1:leaf-1', { reanchor: false })
      expect(notAsked.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).not.toHaveProperty(
        'reanchorAfterDaemonDeath'
      )

      const asked = storeWithLiveOnlyPane()
      asked.getState().captureSleepingAgentSessionForDaemonDeath('tab-1:leaf-1', { reanchor: true })
      expect(asked.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
        origin: 'daemon-death',
        reanchorAfterDaemonDeath: true,
        providerSession: { key: 'session_id', id: 'claude-session-1' }
      })
    })

    it('never overwrites an existing record, with or without the flag', () => {
      const store = storeWithLiveOnlyPane()
      store.getState().captureSleepingAgentSessionForDaemonDeath('tab-1:leaf-1')
      const first = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']

      store.getState().captureSleepingAgentSessionForDaemonDeath('tab-1:leaf-1', { reanchor: true })

      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(first)
      expect(first).not.toHaveProperty('reanchorAfterDaemonDeath')
    })
  })

  describe('R315 ruling: annotating an existing live record', () => {
    function storeWithLiveRecord(sessionId = 'claude-session-1') {
      const store = createTestStore()
      store.setState({
        tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
      } as Partial<AppState>)
      store
        .getState()
        .setAgentStatus(
          'tab-1:leaf-1',
          { state: 'working', prompt: 'p', agentType: 'claude' },
          'Claude',
          { updatedAt: 10, stateStartedAt: 10 },
          { tabId: 'tab-1', worktreeId: 'wt-1' },
          { providerSession: { key: 'session_id', id: sessionId } }
        )
      return store
    }

    it('sets the flag on the live record for the same provider session and changes nothing else', () => {
      const store = storeWithLiveRecord()
      const before = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']!
      expect(before.origin).toBe('live')

      store.getState().captureSleepingAgentSessionForDaemonDeath('tab-1:leaf-1', { reanchor: true })

      const after = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']!
      expect(after).toEqual({ ...before, reanchorAfterDaemonDeath: true })
      expect(after.origin).toBe('live')
    })

    it('never sets the flag for a non-chair capture', () => {
      for (const opts of [undefined, { reanchor: false }]) {
        const store = storeWithLiveRecord()
        const before = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
        store.getState().captureSleepingAgentSessionForDaemonDeath('tab-1:leaf-1', opts)
        expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(before)
      }
    })

    it('does not annotate a live record naming a different provider session than the live status', () => {
      const store = storeWithLiveRecord()
      const record = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']!
      store.setState({
        sleepingAgentSessionsByPaneKey: {
          'tab-1:leaf-1': { ...record, providerSession: { key: 'session_id', id: 'older' } }
        }
      } as Partial<AppState>)
      const before = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']

      store.getState().captureSleepingAgentSessionForDaemonDeath('tab-1:leaf-1', { reanchor: true })

      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(before)
    })

    it('is idempotent once flagged, and clearSleepingAgentReanchorFlag drops only the flag', () => {
      const store = storeWithLiveRecord()
      store.getState().captureSleepingAgentSessionForDaemonDeath('tab-1:leaf-1', { reanchor: true })
      const flagged = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
      store.getState().captureSleepingAgentSessionForDaemonDeath('tab-1:leaf-1', { reanchor: true })
      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(flagged)

      store.getState().clearSleepingAgentReanchorFlag('tab-1:leaf-1')

      const cleared = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']!
      expect(cleared).not.toHaveProperty('reanchorAfterDaemonDeath')
      expect(cleared).toMatchObject({ origin: 'live', providerSession: { id: 'claude-session-1' } })
      store.getState().clearSleepingAgentReanchorFlag('tab-1:leaf-1')
      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(cleared)
    })
  })
})
