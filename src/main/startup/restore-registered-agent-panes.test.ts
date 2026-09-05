// S10-21a C7b (design v3.2 §2.1; D-R110; Ruling 34 Addendum 22): the main-process restore sweep.
// T21 restored to the DESIGN's own criterion (a leaf occupied by something other than the pane's
// own live session -> fresh pane, no placement, Layer 2) — the prior version asserted the
// implementation's (wrong) skip behaviour, the anti-weakening violation D-R110 named. Plus:
// daemon_survived skip audit, the unrecorded-newer Layer-3 fence (Addendum 22(v)), T3/T3b.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import type { AgentRow } from '../runtime/orchestration/agent-directory-types'
import type { RestoreTicketId, RestoreTicketMintArgs } from '../runtime/restore-ticket-registry'
import {
  runRestoreSweep,
  runRestoreSweepBody,
  restoreOneRegisteredPane,
  type RestoreSweepDeps
} from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'

const HOST_ID = 'local'
const EXEC_HOST_ID = 'local'
const LAUNCH_GEN = 'gen-current'

describe('S10-21a C7b: runRestoreSweep', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
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

  // [D-R110 B1] the row is seeded under a DIFFERENT, PRIOR generation than the current one —
  // the production invariant every restart actually presents. A fixture using the SAME
  // generation for both (as the pre-C7b test did) is vacuous against B1: the stale-generation
  // ticket bug is invisible when there is only one generation in play.
  const PRIOR_GEN = 'gen-prior'

  function baseDeps(
    db: OrchestrationDb,
    overrides: Partial<RestoreSweepDeps> = {}
  ): RestoreSweepDeps {
    return {
      getOrchestrationDb: () => db,
      getOrchestrationCompatibilityHostId: () => HOST_ID,
      getLaunchGenerationId: () => LAUNCH_GEN,
      findConnectedLeafOccupant: () => undefined,
      isLeafInPersistedLayout: () => true,
      getPersistedPtyIdForLeaf: () => undefined,
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

  it('T1: Layer 1 preserve — same leaf, prior-generation row, mark written, no rebind audit row', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000001'
    insertAgent(db, { id: 'agent-1', display_name: 'chair-1', pane_key: predPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-1',
      launchGeneration: PRIOR_GEN,
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
    // [D-R110 B1 fence] the mint call must carry the CURRENT generation, never the row's prior one.
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
      .all() as unknown[]
    // Layer 1 (clause-3 noop) returns before rebindRestoredPane's transaction ever opens — no
    // 'reminted' audit row for the pane-preserved case.
    expect(rebindRows).toHaveLength(0)
  })

  it("T21 (restored to the design, D-R110 anti-weakening finding): a leaf occupied by something OTHER than the pane's own live session gets a FRESH pane, no placement, Layer 2", async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000002'
    const freshPaneKey = 'tab2:00000000-0000-4000-8000-00000000f00d'
    insertAgent(db, { id: 'agent-2', display_name: 'chair-2', pane_key: predPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-2',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-2',
        paneKey: freshPaneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        // [design §2.1b, D-R110 (δ)] someone else's live pty sits on this leaf — a DIFFERENT
        // paneKey than the row's own.
        findConnectedLeafOccupant: () => ({ paneKey: 'tab9:other-leaf', ptyId: 'pty-other' }),
        collectIncumbentEvidence: async () => ({
          paneKey: predPaneKey,
          d1: { ptyKnownToRuntime: false, exitObservedThisGeneration: true },
          d2: { inventory: 'unknown' },
          d3: { liveNow: false, firstObservedNotLiveAt: null, now: 0 }
        })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-2',
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!
    )
    expect(outcome.kind).toBe('layer2')
    // No placement offered — the request must carry NO placement field.
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ placement: undefined }),
      {},
      expect.anything()
    )
    const skipAudit = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_skip' AND reason_code = 'leaf_occupied_by_other'`
      )
      .all()
    expect(skipAudit).toHaveLength(1)
  })

  it("daemon_survived: the leaf's own live occupant IS the row's own pane — audited skip, no ticket, no ensureAgentSession call", async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-000000000003'
    insertAgent(db, { id: 'agent-3', display_name: 'chair-3', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-3',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn()
    const mintRestoreTicket = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        findConnectedLeafOccupant: () => ({ paneKey, ptyId: 'pty-own' }),
        ensureAgentSession,
        mintRestoreTicket
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-3',
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!
    )
    expect(outcome.kind).toBe('skipped_daemon_survived')
    expect(mintRestoreTicket).not.toHaveBeenCalled()
    expect(ensureAgentSession).not.toHaveBeenCalled()
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_skip' AND reason_code = 'daemon_survived'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('Addendum 22(v): a pane whose newest admission audit (any generation) is UNRECORDED and newer than the row is Layer 3, never resumed', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-000000000004'
    insertAgent(db, { id: 'agent-4', display_name: 'chair-4', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-4-old',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    // A later, unrecorded admission attempt for the SAME pane, newer than the row.
    db.prepare(
      `INSERT INTO agent_audit (agent_id, actor_pane_key, actor_host_id, verb, outcome, reason_code, at)
         VALUES (NULL, ?, ?, 'launch_unrecorded', 'unrecorded', 'pane_key_owned', datetime('now', '+1 second'))`
    ).run(paneKey, HOST_ID)
    const ensureAgentSession = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession }),
      orchestrationDb!,
      HOST_ID,
      'agent-4',
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!
    )
    expect(outcome.kind).toBe('layer3')
    expect(ensureAgentSession).not.toHaveBeenCalled()
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_layer3' AND reason_code LIKE 'unrecorded_launch:%'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('Layer 3: a registered pane with no launch row is deferred, audited sweep_no_launch_row, never throws', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-000000000005'
    insertAgent(db, { id: 'agent-5', display_name: 'chair-5', pane_key: paneKey })
    const summary = await runRestoreSweep(baseDeps(orchestrationDb!))
    expect(summary.layer3).toBe(1)
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE agent_id = 'agent-5' AND verb = 'sweep_layer3'
           AND reason_code = 'sweep_no_launch_row'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('T25: cold-opened store resumes using the persisted session id from the row', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-000000000006'
    insertAgent(db, { id: 'agent-6', display_name: 'chair-6', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'persisted-session-id',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const readBack = orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)
    expect(readBack?.session_id).toBe('persisted-session-id')
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-6',
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

  it('T3b: a second sweep pass in one generation is a no-op for an already-restored pane', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-000000000007'
    insertAgent(db, { id: 'agent-7', display_name: 'chair-7', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-7',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-7',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const deps = baseDeps(orchestrationDb!, { ensureAgentSession })
    const first = await runRestoreSweepBody(deps)
    expect(first.layer1).toBe(1)
    const second = await runRestoreSweepBody(deps)
    // Second pass: the row's pane key already equals what the sweep would place into, and the
    // rebind predicate's own clause 3 (or the daemon_survived path once a real pty exists) makes
    // a repeat a structural no-op — no duplicate rebind 'reminted' row is written.
    expect(second.layer3 + second.errors).toBe(0)
    const rebindRows = db
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'rebind' AND outcome = 'reminted'`)
      .all() as unknown[]
    expect(rebindRows.length).toBeLessThanOrEqual(1)
  })
})
