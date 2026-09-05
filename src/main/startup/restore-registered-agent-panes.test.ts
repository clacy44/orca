// S10-21a C7b (design v3.2 §2.1; D-R110; Ruling 34 Addendum 22): the main-process restore sweep.
// The decision-table (rows 1-11, Ruling 34 Addendum 27, C7i) tests live in
// restore-registered-agent-panes-decision-table.test.ts — split out to stay under the max-lines
// ratchet. This file keeps the pre-existing, non-decision-table sweep-mechanics tests.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import {
  runRestoreSweep,
  runRestoreSweepBody,
  restoreOneRegisteredPane
} from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'
import {
  HOST_ID,
  EXEC_HOST_ID,
  PRIOR_GEN,
  emptyInventory,
  insertAgent,
  baseDeps
} from './restore-sweep-test-fixtures'

describe('S10-21a C7b/C7i: runRestoreSweep', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
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
    // SCENARIO_CORRECTION (C7i, Ruling 34 Addendum 27, scope item 4 — "A same-pane restore
    // refreshes the agents row's process identity"): was `expect(rebindRows).toHaveLength(0)`
    // with the comment "Layer 1 (clause-3 noop) returns before rebindRestoredPane's transaction
    // ever opens — no 'reminted' audit row for the pane-preserved case." That was true only
    // because process_incarnation was never refreshed on the Layer-1 path before this commit —
    // exactly the gap the companion fix closes. `refreshAgentHandleAfterRespawn` now writes its
    // own 'reminted' row on this same noop path.
    expect(rebindRows).toHaveLength(1)
  })

  it("T21: a leaf occupied by something OTHER than the pane's own live session gets a FRESH pane, no placement, Layer 2 (row 9)", async () => {
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
        findConnectedLeafOccupant: () => ({ paneKey: 'tab9:other-leaf', ptyId: 'pty-other' })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-2',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer2')
    // No placement offered — the request must carry NO placement field.
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ placement: undefined }),
      {},
      expect.anything()
    )
    // [C7i FORCED DEVIATION, see RETURN] kept byte-identical to the pre-C7i reason code.
    const skipAudit = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_skip' AND reason_code = 'leaf_occupied_by_other'`
      )
      .all()
    expect(skipAudit).toHaveLength(1)
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
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory()
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
    // SCENARIO_CORRECTION (C7i, Ruling 34 Addendum 27, scope item 4): was
    // `expect(rebindRows.length).toBeLessThanOrEqual(1)` — each pass is a Layer-1 (clause-3
    // noop) restore of the SAME pane, and the companion fix now refreshes process_incarnation
    // (writing its own 'reminted' row) on every such pass, not just the first. Two passes, two
    // idempotent refreshes — never a duplicate FULL rebind.
    expect(rebindRows.length).toBeLessThanOrEqual(2)
  })
})
