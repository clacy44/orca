// S10-21a C7k (Ruling 34 Addendum 28, D-R118): corrections to the C7i/C7j decision table —
// inventory availability judged before identity (item 2), occupant liveness = round ∪
// connected-now (item 3), and rows 5-6 hold only while a live pty stands on the pane (item 4).
// Split out of restore-registered-agent-panes-decision-table.test.ts to stay under the
// max-lines ratchet.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import { restoreOneRegisteredPane } from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'
import {
  HOST_ID,
  EXEC_HOST_ID,
  LAUNCH_GEN,
  PRIOR_GEN,
  emptyInventory,
  insertAgent,
  baseDeps
} from './restore-sweep-test-fixtures'

describe('S10-21a C7k: decision-table corrections (Ruling 34 Addendum 28)', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  it('row 5/6 correction (C7k, Ruling 34 Addendum 28, item 4): launch row admitted THIS generation but NO occupant at all — proceeds to row 8, sweep_note admitted_launch_without_live_pty, never skipped_leaf_held', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a015'
    insertAgent(db, {
      id: 'agent-row5-nolive',
      display_name: 'chair-row5-nolive',
      pane_key: paneKey
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row5-nolive',
      launchGeneration: LAUNCH_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'sweep_record'
    })
    const launchRow = orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-row5-nolive',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    // Default fixture: no occupant at all.
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession }),
      orchestrationDb!,
      HOST_ID,
      'agent-row5-nolive',
      null,
      'wt-1',
      launchRow,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer1')
    expect(ensureAgentSession).toHaveBeenCalled()
    const heldRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_skip' AND reason_code LIKE 'leaf_held:%'`
      )
      .all()
    expect(heldRows).toHaveLength(0)
    const noteRows = db
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'sweep_note' AND reason_code = ?`)
      .all(`admitted_launch_without_live_pty seq=${launchRow.seq} evidence=sweep_record`)
    expect(noteRows).toHaveLength(1)
  })

  it('row 5/6 correction (C7k, Ruling 34 Addendum 28, item 4): launch row admitted THIS generation, an occupant exists but its pty is ABSENT from the round — proceeds to row 10, never skipped_leaf_held', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a016'
    insertAgent(db, {
      id: 'agent-row6-nolive',
      display_name: 'chair-row6-nolive',
      pane_key: paneKey
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row6-nolive',
      launchGeneration: LAUNCH_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const launchRow = orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-row6-nolive',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        findConnectedLeafOccupant: () => ({ paneKey, ptyId: 'pty-row6-dead' })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-row6-nolive',
      null,
      'wt-1',
      launchRow,
      // pty-row6-dead NOT in the round -> not live.
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer1')
    const heldRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_skip' AND reason_code LIKE 'leaf_held:%'`
      )
      .all()
    expect(heldRows).toHaveLength(0)
    const noteRows = db
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'sweep_note' AND reason_code = ?`)
      .all(`admitted_launch_without_live_pty seq=${launchRow.seq} evidence=host_launch`)
    expect(noteRows).toHaveLength(1)
  })

  it('row 2 correction (C7k, Ruling 34 Addendum 28, item 2): row 4 shape (no identity) with a NULL round defers as row 2, never notes row 4', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a017'
    insertAgent(db, { id: 'agent-row2b', display_name: 'chair-row2b', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row2b',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession }),
      orchestrationDb!,
      HOST_ID,
      'agent-row2b',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      null
    )
    expect(outcome.kind).toBe('layer3')
    expect(ensureAgentSession).not.toHaveBeenCalled()
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_layer3'
           AND reason_code = 'sweep_deferred: controller_inventory_unavailable'`
      )
      .all()
    expect(rows).toHaveLength(1)
    const row4NoteRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_note'
           AND reason_code = 'agent_identity_absent: row_has_no_process_incarnation'`
      )
      .all()
    expect(row4NoteRows).toHaveLength(0)
  })

  // [S10-21a C7l, Ruling 34 Addendum 29 item 6, N5, SCENARIO_CORRECTION] Was
  // `round=present` — `round=` now states what was OBSERVED from `ptyState`, never 'present' as
  // a stand-in for "the round existed"; the round here is non-null but does not list
  // 'pty-unknown', so it reads `round=not_listed`.
  it('row 10/11 correction (C7k, Ruling 34 Addendum 28, item 2): occupant liveness UNKNOWN never places — restores without placement, distinct reason from row 11', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a018'
    insertAgent(db, {
      id: 'agent-row-unknown',
      display_name: 'chair-row-unknown',
      pane_key: paneKey
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row-unknown',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-row-unknown',
        paneKey: 'tab8:00000000-0000-4000-8000-00000000f00f',
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        findConnectedLeafOccupant: () => ({ paneKey, ptyId: 'pty-unknown' }),
        ensureAgentSession,
        // Evidence bundle supplies no `ptyState` function at all -> 'unknown', per item 2.
        collectIncumbentEvidence: async (pk, ptyId) => ({
          paneKey: pk,
          ptyId,
          d1: { ptyKnownToRuntime: false, exitObservedThisGeneration: true },
          d2: { inventory: 'unknown' },
          d3: { liveNow: false, firstObservedNotLiveAt: null, now: 0 }
        })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-row-unknown',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer2')
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ placement: undefined }),
      {},
      expect.anything()
    )
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_note'
           AND reason_code = 'leaf_liveness_unknown: occupant pty-unknown round=not_listed'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('row 11 correction (C7k, Ruling 34 Addendum 28, item 3): occupant CONNECTED NOW but absent from the (older) round -> row 11, never row 10', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a019'
    insertAgent(db, {
      id: 'agent-row-connected',
      display_name: 'chair-row-connected',
      pane_key: paneKey
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row-connected',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-row-connected',
        paneKey: 'tab8:00000000-0000-4000-8000-00000000f010',
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        findConnectedLeafOccupant: () => ({ paneKey, ptyId: 'pty-connected' }),
        ensureAgentSession,
        collectIncumbentEvidence: async (pk, ptyId) => ({
          paneKey: pk,
          ptyId,
          d1: { ptyKnownToRuntime: false, exitObservedThisGeneration: true },
          d2: { inventory: 'unknown' },
          d3: { liveNow: false, firstObservedNotLiveAt: null, now: 0 },
          // Older round says absent, but the runtime has it connected right now.
          ptyState: () => 'absent',
          ptyConnectedNow: () => true
        })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-row-connected',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer2')
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ placement: undefined }),
      {},
      expect.anything()
    )
    // [S10-21a C7l, Ruling 34 Addendum 29 item 5, N4, SCENARIO_CORRECTION] Was
    // 'leaf_occupied_by_live_non_agent_pty pty-connected' — this candidate's
    // `processIncarnation` is `null`, so its identity status is `unknown_no_identity`.
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_note'
           AND reason_code = 'leaf_occupied_by_live_pty_identity_unknown pty-connected'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })
})
