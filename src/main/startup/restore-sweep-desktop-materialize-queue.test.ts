// S10-21c B6 (design §2 S9; D-R153-b6): unit tests for the desktop-materialization queue's own
// drain logic — the functional core `orca-runtime.ts#materializeRestoredAgentPanes` delegates to
// (see that method's own doc comment). Exercised here directly against fakes rather than through
// a full `OrcaRuntimeService` instance, since the drain logic itself is plain, dependency-injected
// functions with no runtime-internal state beyond what `DesktopMaterializeQueueState` holds.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import {
  createDesktopMaterializeQueueState,
  enqueueRestoredPaneForMaterialization,
  drainDesktopMaterializeQueue,
  type DesktopMaterializeNotifier,
  type RestoredPaneMaterializeSurface
} from './restore-sweep-desktop-materialize-queue'

const HOST_ID = 'local'
const alwaysLive = (): boolean => true

function surface(
  overrides: Partial<RestoredPaneMaterializeSurface> = {}
): RestoredPaneMaterializeSurface {
  return {
    paneKey: 'tab1:00000000-0000-4000-8000-000000000030',
    agentId: 'agent-30',
    worktreeId: 'wt-1',
    tabId: 'tab1',
    leafId: '00000000-0000-4000-8000-000000000030',
    ptyId: 'pty-30',
    title: 'chair-30',
    launchAgent: 'claude',
    expectedProcessIdentity: { terminalHandle: 'handle-30', incarnationId: 'inc-30' },
    ...overrides
  }
}

describe('S10-21c B6, design §2 S9, D-R153-b6: drainDesktopMaterializeQueue', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  function rawDb(): Database.Database {
    db = new OrchestrationDb(':memory:')
    return (db as unknown as { db: Database.Database }).db
  }

  function auditRows(verb: string, agentId?: string): { reason_code: string }[] {
    const rawDbHandle = (db as unknown as { db: Database.Database }).db
    return agentId
      ? (rawDbHandle
          .prepare(`SELECT * FROM agent_audit WHERE verb = ? AND agent_id = ?`)
          .all(verb, agentId) as { reason_code: string }[])
      : (rawDbHandle.prepare(`SELECT * FROM agent_audit WHERE verb = ?`).all(verb) as {
          reason_code: string
        }[])
  }

  it('issues exactly one reveal per queued pane, deletes it, and audits it; a second drain issues none', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())
    const revealTerminalSession = vi.fn().mockResolvedValue({
      tabId: 'tab1',
      identity: {
        worktreeId: 'wt-1',
        tabId: 'tab1',
        leafId: '00000000-0000-4000-8000-000000000030',
        ptyId: 'pty-30'
      }
    })
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }

    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, db, HOST_ID)
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    expect(revealTerminalSession).toHaveBeenCalledWith('wt-1', {
      ptyId: 'pty-30',
      title: 'chair-30',
      launchAgent: 'claude',
      tabId: 'tab1',
      leafId: '00000000-0000-4000-8000-000000000030',
      presentation: 'background',
      expectedProcessIdentity: { terminalHandle: 'handle-30', incarnationId: 'inc-30' }
    })
    expect(state.queue.has(surface().paneKey)).toBe(false)
    const revealedRows = auditRows('sweep_note', 'agent-30')
    expect(revealedRows).toHaveLength(1)
    expect(revealedRows[0].reason_code).toBe('desktop_materialize: revealed tab=tab1')

    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, db, HOST_ID)
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
  })

  it('a reveal returning a mismatched identity leaves the pane queued, audits the refusal, and is retried', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())
    const revealTerminalSession = vi.fn().mockResolvedValue({
      tabId: 'tab1',
      // Wrong ptyId — a mismatched identity.
      identity: {
        worktreeId: 'wt-1',
        tabId: 'tab1',
        leafId: '00000000-0000-4000-8000-000000000030',
        ptyId: 'pty-WRONG'
      }
    })
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, db, HOST_ID)
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    expect(state.queue.has(surface().paneKey)).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('desktop materialize reveal did not complete'),
      expect.objectContaining({ paneKey: surface().paneKey })
    )
    const refusedRows = auditRows('sweep_note', 'agent-30')
    expect(refusedRows).toHaveLength(1)
    expect(refusedRows[0].reason_code).toBe('desktop_materialize_refused: identity_mismatch')

    // Retried on the next drain since it was never removed from the queue.
    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, db, HOST_ID)
    expect(revealTerminalSession).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('a reveal that rejects (the real primitive throws on mismatch/timeout) is caught the same way', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())
    const revealTerminalSession = vi
      .fn()
      .mockRejectedValue(new Error('terminal_reveal_identity_mismatch'))
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      drainDesktopMaterializeQueue(state, notifier, alwaysLive, db, HOST_ID)
    ).resolves.toBeUndefined()
    expect(state.queue.has(surface().paneKey)).toBe(true)
    warn.mockRestore()
  })

  it('a dead pty is skipped without a reveal attempt, deleted, and audited pty_gone', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())
    const revealTerminalSession = vi.fn()
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }

    await drainDesktopMaterializeQueue(state, notifier, () => false, db, HOST_ID)
    expect(revealTerminalSession).not.toHaveBeenCalled()
    expect(state.queue.has(surface().paneKey)).toBe(false)
    const skippedRows = auditRows('sweep_note', 'agent-30')
    expect(skippedRows).toHaveLength(1)
    expect(skippedRows[0].reason_code).toBe('desktop_materialize_skipped: pty_gone')
  })

  it('serve (no notifier installed): the drain is a no-op and returns cleanly', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())

    await expect(
      drainDesktopMaterializeQueue(state, null, alwaysLive, db, HOST_ID)
    ).resolves.toBeUndefined()
    expect(state.queue.size).toBe(1)
  })

  it('a notifier installed but without revealTerminalSession is also a clean no-op', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())

    await expect(
      drainDesktopMaterializeQueue(state, {}, alwaysLive, db, HOST_ID)
    ).resolves.toBeUndefined()
    expect(state.queue.size).toBe(1)
  })

  it('a renderer-epoch reload never re-reveals a pane already resolved this run (revealed or dead)', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())
    const revealTerminalSession = vi.fn().mockResolvedValue({
      tabId: 'tab1',
      identity: {
        worktreeId: 'wt-1',
        tabId: 'tab1',
        leafId: '00000000-0000-4000-8000-000000000030',
        ptyId: 'pty-30'
      }
    })
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }

    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, db, HOST_ID)
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    // A subsequent drain (standing in for a post-reload call) has nothing left to reveal — the
    // completed entry was deleted, not merely epoch-marked (D-R153-b6 F1).
    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, db, HOST_ID)
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
  })

  it('one summary log line per drain, counting queued/revealed/refused/skipped', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(
      state,
      surface({ paneKey: 'tab1:leaf-revealed', ptyId: 'pty-revealed', agentId: 'agent-r' })
    )
    enqueueRestoredPaneForMaterialization(
      state,
      surface({ paneKey: 'tab1:leaf-dead', ptyId: 'pty-dead', agentId: 'agent-d' })
    )
    const revealTerminalSession = vi.fn().mockResolvedValue({
      tabId: 'tab1',
      identity: {
        worktreeId: 'wt-1',
        tabId: 'tab1',
        leafId: '00000000-0000-4000-8000-000000000030',
        ptyId: 'pty-revealed'
      }
    })
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await drainDesktopMaterializeQueue(
      state,
      notifier,
      (ptyId) => ptyId === 'pty-revealed',
      db,
      HOST_ID
    )
    expect(log).toHaveBeenCalledWith(
      '[restore-sweep] desktop materialize: queued 2 revealed 1 refused 0 skipped 1'
    )
    log.mockRestore()
  })
})
