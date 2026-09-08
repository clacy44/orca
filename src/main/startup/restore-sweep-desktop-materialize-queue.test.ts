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
const noTitleFallback = (): string | null => null

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

    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
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

    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
  })

  // [D-R155-b6b finding 4] The recorded title still wins — the fallback is never even called.
  it('a null recorded title falls back to resolveTitle at drain time', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface({ title: null }))
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
    const resolveTitle = vi.fn((ptyId: string) => (ptyId === 'pty-30' ? 'fallback-title' : null))

    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, resolveTitle, db, HOST_ID)
    expect(resolveTitle).toHaveBeenCalledWith('pty-30')
    expect(revealTerminalSession).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({ title: 'fallback-title' })
    )
  })

  it('a non-null recorded title is used as-is; resolveTitle is never consulted', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface({ title: 'chair-30' }))
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
    const resolveTitle = vi.fn(() => 'should-not-be-used')

    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, resolveTitle, db, HOST_ID)
    expect(resolveTitle).not.toHaveBeenCalled()
    expect(revealTerminalSession).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({ title: 'chair-30' })
    )
  })

  it('a reveal returning a mismatched identity leaves the pane queued, audits identity_mismatch, and is retried', async () => {
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

    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
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
    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
    expect(revealTerminalSession).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  // [D-R155-b6b finding 3] The local identity check and the primitive's own mismatch throw the
  // same message, so both land on identity_mismatch — never folded together with a timeout or an
  // arbitrary reveal error.
  it('a reveal rejecting with terminal_reveal_identity_mismatch is coded identity_mismatch', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())
    const revealTerminalSession = vi
      .fn()
      .mockRejectedValue(new Error('terminal_reveal_identity_mismatch'))
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      drainDesktopMaterializeQueue(state, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
    ).resolves.toBeUndefined()
    expect(state.queue.has(surface().paneKey)).toBe(true)
    const rows = auditRows('sweep_note', 'agent-30')
    expect(rows).toHaveLength(1)
    expect(rows[0].reason_code).toBe('desktop_materialize_refused: identity_mismatch')
    warn.mockRestore()
  })

  // [D-R155-b6b finding 3] The primitive's own 10s timeout ("Terminal reveal timed out") gets its
  // own code — the EXPECTED cold-start outcome when the end-of-sweep trigger races a renderer
  // that has not hydrated yet, so it must never read as an identity defect.
  it("a reveal rejecting with the primitive's timeout is coded reveal_timeout", async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())
    const revealTerminalSession = vi.fn().mockRejectedValue(new Error('Terminal reveal timed out'))
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
    const rows = auditRows('sweep_note', 'agent-30')
    expect(rows).toHaveLength(1)
    expect(rows[0].reason_code).toBe('desktop_materialize_refused: reveal_timeout')
    warn.mockRestore()
  })

  // [D-R155-b6b finding 3] Anything else (runtime_unavailable, an arbitrary renderer reply
  // error, ...) keeps its own diagnostic text rather than being folded into identity_mismatch.
  it('any other reveal rejection is coded reveal_error <message>', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())
    const revealTerminalSession = vi.fn().mockRejectedValue(new Error('runtime_unavailable'))
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
    const rows = auditRows('sweep_note', 'agent-30')
    expect(rows).toHaveLength(1)
    expect(rows[0].reason_code).toBe(
      'desktop_materialize_refused: reveal_error runtime_unavailable'
    )
    warn.mockRestore()
  })

  it('a dead pty is skipped without a reveal attempt, deleted, and audited pty_gone', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())
    const revealTerminalSession = vi.fn()
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }

    await drainDesktopMaterializeQueue(state, notifier, () => false, noTitleFallback, db, HOST_ID)
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
      drainDesktopMaterializeQueue(state, null, alwaysLive, noTitleFallback, db, HOST_ID)
    ).resolves.toBeUndefined()
    expect(state.queue.size).toBe(1)
  })

  it('a notifier installed but without revealTerminalSession is also a clean no-op', async () => {
    rawDb()
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())

    await expect(
      drainDesktopMaterializeQueue(state, {}, alwaysLive, noTitleFallback, db, HOST_ID)
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

    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    // A subsequent drain (standing in for a post-reload call) has nothing left to reveal — the
    // completed entry was deleted, not merely epoch-marked (D-R153-b6 F1).
    await drainDesktopMaterializeQueue(state, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
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
      noTitleFallback,
      db,
      HOST_ID
    )
    expect(log).toHaveBeenCalledWith(
      '[restore-sweep] desktop materialize: queued 2 revealed 1 refused 0 skipped 1'
    )
    log.mockRestore()
  })

  // [D-R155-b6b finding 2] db === null stands for "the caller's getOrchestrationDb() failed" —
  // audits are skipped, but the drain still runs and still reveals/deletes/skips.
  it('a null db (getOrchestrationDb failed at the caller) skips audits but still drains', async () => {
    // rawDb() only to keep the shared afterEach's db.close() valid for this file's own
    // invariant — the drain call below is passed `null`, never this instance.
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

    await expect(
      drainDesktopMaterializeQueue(state, notifier, alwaysLive, noTitleFallback, null, HOST_ID)
    ).resolves.toBeUndefined()
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    expect(state.queue.has(surface().paneKey)).toBe(false)
  })

  // [D-R155-b6b finding 2] A throwing db.writeAgentAudit must never reject the drain — the pane
  // still reveals and deletes; the audit failure is a loud console.warn, not a thrown error.
  it('a throwing db write on the success path never rejects the drain, and the pane is still revealed and deleted', async () => {
    rawDb()
    vi.spyOn(db, 'writeAgentAudit').mockImplementation(() => {
      throw new Error('disk full')
    })
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      drainDesktopMaterializeQueue(state, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
    ).resolves.toBeUndefined()
    // Revealed and deleted despite the audit write throwing — never misclassified as a refusal.
    expect(state.queue.has(surface().paneKey)).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      '[restore-sweep] desktop materialize audit write failed',
      expect.objectContaining({ paneKey: surface().paneKey })
    )
    warn.mockRestore()
  })

  // [D-R155-b6b finding 2] Same guarantee on a different entry's failure: one throwing audit
  // write never blocks another entry's own drain outcome.
  it('a throwing db write on one entry does not block another entry in the same drain', async () => {
    rawDb()
    const originalWrite = db.writeAgentAudit.bind(db)
    vi.spyOn(db, 'writeAgentAudit').mockImplementation((args) => {
      if (args.agentId === 'agent-fails') {
        throw new Error('disk full')
      }
      return originalWrite(args)
    })
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(
      state,
      surface({ paneKey: 'tab1:leaf-fails', ptyId: 'pty-fails', agentId: 'agent-fails' })
    )
    enqueueRestoredPaneForMaterialization(
      state,
      surface({ paneKey: 'tab1:leaf-ok', ptyId: 'pty-ok', agentId: 'agent-ok' })
    )
    const revealTerminalSession = vi.fn(
      (worktreeId: string, opts: { tabId: string; leafId: string; ptyId: string }) =>
        Promise.resolve({
          tabId: opts.tabId,
          identity: { worktreeId, tabId: opts.tabId, leafId: opts.leafId, ptyId: opts.ptyId }
        })
    )
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      drainDesktopMaterializeQueue(state, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
    ).resolves.toBeUndefined()
    expect(state.queue.has('tab1:leaf-fails')).toBe(false)
    expect(state.queue.has('tab1:leaf-ok')).toBe(false)
    const okRows = auditRows('sweep_note', 'agent-ok')
    expect(okRows).toHaveLength(1)
    expect(okRows[0].reason_code).toBe('desktop_materialize: revealed tab=tab1')
    warn.mockRestore()
  })
})
