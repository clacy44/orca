// S10-21a C7 (design v3.2 §2.1): the main-process restore sweep. T1 (Layer 1 preserve), T21/F-13
// (occupied leaf: no placement offered, no mint), T25 (cold-opened store: resumes from the
// persisted row, not any in-memory value), Layer 3 (no launch row → audited, no throw).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import type { AgentRow } from '../runtime/orchestration/agent-directory-types'
import type { RestoreTicketId, RestoreTicketMintArgs } from '../runtime/restore-ticket-registry'
import { runRestoreSweep, type RestoreSweepDeps } from './restore-registered-agent-panes'

const HOST_ID = 'local'
const EXEC_HOST_ID = 'local'
const LAUNCH_GEN = 'gen-1'

describe('S10-21a C7: runRestoreSweep', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function insertAgent(
    db: Database.Database,
    overrides: Partial<AgentRow> & { id: string; display_name: string; pane_key: string | null }
  ): void {
    db.prepare(
      `INSERT INTO agents (
         id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
         worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
         quarantined_at, tombstoned_at, origin_kind, origin_pane_key, origin_handle,
         origin_host_id
       ) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, 'idle', 0, 0, NULL,
         NULL, 'pane', ?, NULL, ?)`
    ).run(
      overrides.id,
      overrides.display_name,
      overrides.host_id ?? HOST_ID,
      overrides.pane_key,
      overrides.worktree_id ?? 'wt-1',
      overrides.pane_key,
      overrides.origin_host_id ?? HOST_ID
    )
  }

  function baseDeps(
    db: OrchestrationDb,
    overrides: Partial<RestoreSweepDeps> = {}
  ): RestoreSweepDeps {
    return {
      getOrchestrationDb: () => db,
      getOrchestrationCompatibilityHostId: () => HOST_ID,
      getLaunchGenerationId: () => LAUNCH_GEN,
      leafHoldsLiveOrStablePane: () => false,
      ensureAgentSession: vi.fn(),
      collectIncumbentEvidence: async () => ({
        paneKey: 'tab1:leaf-a',
        d1: { ptyKnownToRuntime: false, exitObservedThisGeneration: true },
        d2: { inventory: 'unknown' },
        d3: { liveNow: false, firstObservedNotLiveAt: null, now: 0 }
      }),
      getTerminalProcessIncarnation: () => null,
      mintRestoreTicket: (payload: RestoreTicketMintArgs) =>
        JSON.stringify(payload) as unknown as RestoreTicketId,
      ...overrides
    }
  }

  it('T1: Layer 1 preserve — same leaf, ensureAgentSession returns the same pane key, mark written, no rebind audit row', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000001'
    insertAgent(db, { id: 'agent-1', display_name: 'chair-1', pane_key: predPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-1',
      launchGeneration: LAUNCH_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-1',
        paneKey: predPaneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const summary = await runRestoreSweep(baseDeps(orchestrationDb!, { ensureAgentSession }))
    expect(summary.layer1).toBe(1)
    expect(summary.layer2).toBe(0)
    expect(summary.layer3).toBe(0)
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'explicit',
        providerSession: { key: 'session_id', id: 'sess-1' },
        placement: { tabId: 'tab1', leafId: '00000000-0000-4000-8000-000000000001' }
      }),
      {},
      expect.objectContaining({
        restoreProvenance: expect.objectContaining({ kind: 'host-restore' })
      })
    )
    expect(orchestrationDb!.getSweepRestoreMark(HOST_ID, predPaneKey)).toBe(true)
    const rebindRows = db
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'rebind' AND outcome = 'reminted'`)
      .all()
    expect(rebindRows).toHaveLength(0)
  })

  it('T21/F-13: occupied leaf — no ticket minted, no placement offered, no clearing of the stale binding', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-000000000002'
    insertAgent(db, { id: 'agent-2', display_name: 'chair-2', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-2',
      launchGeneration: LAUNCH_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const mintRestoreTicket = vi.fn()
    const ensureAgentSession = vi.fn()
    const summary = await runRestoreSweep(
      baseDeps(orchestrationDb!, {
        // F-13: a stale-or-live-occupied leaf is treated as occupied — the sweep neither clears
        // it nor places into it; it just leaves the row for the register ritual (§2.1c "never
        // adoption").
        leafHoldsLiveOrStablePane: () => true,
        ensureAgentSession,
        mintRestoreTicket
      })
    )
    expect(summary.skippedAlreadyLive).toBe(1)
    expect(summary.candidates).toBe(0)
    expect(mintRestoreTicket).not.toHaveBeenCalled()
    expect(ensureAgentSession).not.toHaveBeenCalled()
    expect(orchestrationDb!.getSweepRestoreMark(HOST_ID, paneKey)).toBe(false)
  })

  it('Layer 3: a registered pane with no launch row is deferred, audited sweep_no_launch_row, never throws', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-000000000003'
    insertAgent(db, { id: 'agent-3', display_name: 'chair-3', pane_key: paneKey })
    const summary = await runRestoreSweep(baseDeps(orchestrationDb!))
    expect(summary.layer3).toBe(1)
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE agent_id = 'agent-3' AND verb = 'sweep_layer3'
           AND reason_code = 'sweep_no_launch_row'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('T25: cold-opened store resumes using the persisted session id from the row, not an injected value', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-000000000004'
    insertAgent(db, { id: 'agent-4', display_name: 'chair-4', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'persisted-session-id',
      launchGeneration: LAUNCH_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    // Cold open: a FRESH OrchestrationDb handle over the same in-memory fixture is not possible
    // for ':memory:' (each connection is its own db) — the fixture instead asserts what T25
    // actually checks: nothing in this call path can supply the session id except the row this
    // same call reads back, since no hook-derived or in-memory source is wired into `baseDeps`.
    const readBack = orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)
    expect(readBack?.session_id).toBe('persisted-session-id')
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-4',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    await runRestoreSweep(baseDeps(orchestrationDb!, { ensureAgentSession }))
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSession: { key: 'session_id', id: 'persisted-session-id' }
      }),
      {},
      expect.anything()
    )
  })
})
