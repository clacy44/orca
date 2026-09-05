// S10-21a C7i (Ruling 34 Addendum 27, D-R116 REJECT of C7h, design by D-R117): survival is now
// the agent's own process identity joined against ONE shared inventory round — the decision
// table's rows 1-11 (row 7/self-resume watermark is C7j, not here). Split out of
// restore-registered-agent-panes.test.ts (which keeps the pre-existing sweep-mechanics tests) to
// stay under the max-lines ratchet.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import type { RestoreTicketId, RestoreTicketMintArgs } from '../runtime/restore-ticket-registry'
import { restoreOneRegisteredPane, runRestoreSweepBody } from './restore-registered-agent-panes'
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

describe('S10-21a C7i: decision-table rows (Ruling 34 Addendum 27)', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  it('row 1: alive — the identity map lists the ptyId with the SAME incarnation, skipped_daemon_survived, never spawns', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a001'
    insertAgent(db, {
      id: 'agent-row1',
      display_name: 'chair-row1',
      pane_key: paneKey,
      process_incarnation: 'pty-1:inc-1'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row1',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn()
    const mintRestoreTicket = vi.fn()
    const inventory = emptyInventory({
      allLivePtyIds: new Set(['pty-1']),
      terminalIdentityByPtyId: new Map([['pty-1', { handle: 'term_1', incarnationId: 'inc-1' }]])
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession, mintRestoreTicket }),
      orchestrationDb!,
      HOST_ID,
      'agent-row1',
      'pty-1:inc-1',
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      inventory
    )
    expect(outcome.kind).toBe('skipped_daemon_survived')
    expect(ensureAgentSession).not.toHaveBeenCalled()
    expect(mintRestoreTicket).not.toHaveBeenCalled()
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_skip'
           AND reason_code = 'daemon_survived: agent_pty_identity_matched pty-1:inc-1'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('row 2: unknown_inventory — the round is null, deferred loudly (layer3), never read as dead', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a002'
    insertAgent(db, {
      id: 'agent-row2',
      display_name: 'chair-row2',
      pane_key: paneKey,
      process_incarnation: 'pty-2:inc-2'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row2',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession }),
      orchestrationDb!,
      HOST_ID,
      'agent-row2',
      'pty-2:inc-2',
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
  })

  it('row 3: unknown_ambiguous_pty — allLivePtyIds has the ptyId but the identity map does not, deferred (layer3)', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a003'
    insertAgent(db, {
      id: 'agent-row3',
      display_name: 'chair-row3',
      pane_key: paneKey,
      process_incarnation: 'pty-3:inc-3'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row3',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn()
    const inventory = emptyInventory({ allLivePtyIds: new Set(['pty-3']) })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession }),
      orchestrationDb!,
      HOST_ID,
      'agent-row3',
      'pty-3:inc-3',
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      inventory
    )
    expect(outcome.kind).toBe('layer3')
    expect(ensureAgentSession).not.toHaveBeenCalled()
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_layer3'
           AND reason_code = 'sweep_deferred: agent_pty_identity_ambiguous pty-3'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('row 4: unknown_no_identity — no process_incarnation, noted (not skipped) and treated as dead for rows 5-11', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a004'
    insertAgent(db, { id: 'agent-row4', display_name: 'chair-row4', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row4',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-row4',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession }),
      orchestrationDb!,
      HOST_ID,
      'agent-row4',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer1')
    expect(ensureAgentSession).toHaveBeenCalled()
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_note'
           AND reason_code = 'agent_identity_absent: row_has_no_process_incarnation'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('row 5: dead, launch row admitted THIS generation via sweep_record, a LIVE occupant on the row own pane — skipped_leaf_held (yield)', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a005'
    insertAgent(db, { id: 'agent-row5', display_name: 'chair-row5', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row5',
      launchGeneration: LAUNCH_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'sweep_record'
    })
    const launchRow = orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!
    const ensureAgentSession = vi.fn()
    const mintRestoreTicket = vi.fn()
    // [S10-21a C7k, Ruling 34 Addendum 28, item 4 — SCENARIO_CORRECTION] rows 5-6 now hold ONLY
    // while a live pty stands on the pane — a live own-pane occupant is required here to still
    // reach 'skipped_leaf_held'; see the two new tests below for the "no live pty" case.
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        mintRestoreTicket,
        findConnectedLeafOccupant: () => ({ paneKey, ptyId: 'pty-row5-occ' })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-row5',
      null,
      'wt-1',
      launchRow,
      emptyInventory({ allLivePtyIds: new Set(['pty-row5-occ']) })
    )
    expect(outcome.kind).toBe('skipped_leaf_held')
    expect(ensureAgentSession).not.toHaveBeenCalled()
    expect(mintRestoreTicket).not.toHaveBeenCalled()
    const rows = db
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'sweep_skip' AND reason_code = ?`)
      .all(`leaf_held: resume_admitted_this_generation seq=${launchRow.seq}`)
    expect(rows).toHaveLength(1)
  })

  it('row 6: dead, launch row admitted THIS generation via host_launch, a LIVE occupant on the row own pane — skipped_leaf_held (yield)', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a006'
    insertAgent(db, { id: 'agent-row6', display_name: 'chair-row6', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row6',
      launchGeneration: LAUNCH_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const launchRow = orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!
    const ensureAgentSession = vi.fn()
    const mintRestoreTicket = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        mintRestoreTicket,
        findConnectedLeafOccupant: () => ({ paneKey, ptyId: 'pty-row6-occ' })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-row6',
      null,
      'wt-1',
      launchRow,
      emptyInventory({ allLivePtyIds: new Set(['pty-row6-occ']) })
    )
    expect(outcome.kind).toBe('skipped_leaf_held')
    expect(ensureAgentSession).not.toHaveBeenCalled()
    expect(mintRestoreTicket).not.toHaveBeenCalled()
    const rows = db
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'sweep_skip' AND reason_code = ?`)
      .all(`leaf_held: new_launch_admitted_this_generation seq=${launchRow.seq}`)
    expect(rows).toHaveLength(1)
  })

  it("[S10-21a C7l item 3] row 5: no leaf occupant, but a connected pty record on the pane (runtime's own records) — skipped_leaf_held (yield)", async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000c003'
    insertAgent(db, {
      id: 'agent-row3-runtime',
      display_name: 'chair-row3-runtime',
      pane_key: paneKey
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row3-runtime',
      launchGeneration: LAUNCH_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'sweep_record'
    })
    const launchRow = orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!
    const ensureAgentSession = vi.fn()
    const mintRestoreTicket = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        mintRestoreTicket,
        // No renderer-graph occupant at all — only the runtime's OWN pty record on this pane.
        findConnectedLeafOccupant: () => undefined,
        findConnectedPtyForPane: (pk) =>
          pk === paneKey ? { paneKey: pk, ptyId: 'pty-row3-runtime' } : undefined
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-row3-runtime',
      null,
      'wt-1',
      launchRow,
      emptyInventory()
    )
    expect(outcome.kind).toBe('skipped_leaf_held')
    expect(ensureAgentSession).not.toHaveBeenCalled()
    expect(mintRestoreTicket).not.toHaveBeenCalled()
    const rows = db
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'sweep_skip' AND reason_code = ?`)
      .all(`leaf_held: resume_admitted_this_generation seq=${launchRow.seq}`)
    expect(rows).toHaveLength(1)
  })

  it('row 8 (first half): dead, no occupant, leaf present in the persisted layout — restore WITH placement', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a008'
    insertAgent(db, { id: 'agent-row8a', display_name: 'chair-row8a', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row8a',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-row8a',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession, isLeafInPersistedLayout: () => true }),
      orchestrationDb!,
      HOST_ID,
      'agent-row8a',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer1')
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: { tabId: 'tab1', leafId: '00000000-0000-4000-8000-00000000a008' }
      }),
      {},
      expect.anything()
    )
    const noteRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_note' AND reason_code LIKE 'no_placement:%'`
      )
      .all()
    expect(noteRows).toHaveLength(0)
  })

  it('row 8 (second half): dead, no occupant, leaf ABSENT from the persisted layout — restore WITHOUT placement', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a009'
    insertAgent(db, { id: 'agent-row8b', display_name: 'chair-row8b', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row8b',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-row8b',
        paneKey: 'tab2:00000000-0000-4000-8000-00000000f00d',
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession, isLeafInPersistedLayout: () => false }),
      orchestrationDb!,
      HOST_ID,
      'agent-row8b',
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
           AND reason_code = 'no_placement: leaf_absent_from_persisted_layout'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('row 9: dead, occupant on ANOTHER paneKey — restore, no placement (see also T21)', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a010'
    insertAgent(db, { id: 'agent-row9', display_name: 'chair-row9', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row9',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-row9',
        paneKey: 'tab9:00000000-0000-4000-8000-00000000f00d',
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        findConnectedLeafOccupant: () => ({ paneKey: 'tab9:other-leaf', ptyId: 'pty-other' })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-row9',
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
  })

  it('row 10: dead, own-pane occupant, ptyState ABSENT from the shared round — a stale surface, restored over with placement', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a011'
    insertAgent(db, { id: 'agent-row10', display_name: 'chair-row10', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row10',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-row10',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const mintRestoreTicket = vi.fn(
      (payload: RestoreTicketMintArgs) => JSON.stringify(payload) as unknown as RestoreTicketId
    )
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        findConnectedLeafOccupant: () => ({ paneKey, ptyId: 'pty-own' }),
        ensureAgentSession,
        mintRestoreTicket
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-row10',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      // pty-own is NOT in the round -> ptyState('pty-own') === 'absent'.
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer1')
    expect(mintRestoreTicket).toHaveBeenCalled()
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: { tabId: 'tab1', leafId: '00000000-0000-4000-8000-00000000a011' }
      }),
      {},
      expect.anything()
    )
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_note'
           AND reason_code = 'stale_own_surface: occupant_pty_absent_from_inventory pty-own'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('row 11: dead, own-pane occupant, ptyState PRESENT in the shared round — never yielded to, never spawned over; restores into a fresh pane, no placement', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a012'
    insertAgent(db, { id: 'agent-row11', display_name: 'chair-row11', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row11',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-row11',
        paneKey: 'tab8:00000000-0000-4000-8000-00000000f00d',
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const mintRestoreTicket = vi.fn(
      (payload: RestoreTicketMintArgs) => JSON.stringify(payload) as unknown as RestoreTicketId
    )
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        findConnectedLeafOccupant: () => ({ paneKey, ptyId: 'pty-live' }),
        ensureAgentSession,
        mintRestoreTicket
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-row11',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory({ allLivePtyIds: new Set(['pty-live']) })
    )
    // [SCENARIO_CORRECTION, C7h -> C7i] under C7h this was 'skipped_leaf_held' (no ticket, no
    // spawn) — a live-but-not-the-agent pty is now never yielded to and never spawned over: the
    // agent restores into a FRESH pane instead.
    expect(outcome.kind).toBe('layer2')
    expect(mintRestoreTicket).toHaveBeenCalled()
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ placement: undefined }),
      {},
      expect.anything()
    )
    // [S10-21a C7l, Ruling 34 Addendum 29 item 5, N4, SCENARIO_CORRECTION] Was
    // 'leaf_occupied_by_live_non_agent_pty pty-live' — this candidate's `processIncarnation` is
    // `null` (no row set one), so its identity status is `unknown_no_identity`, never provably
    // 'dead'; row 11's reason must never assert "non_agent" (a fact never established) for it.
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_note'
           AND reason_code = 'leaf_occupied_by_live_pty_identity_unknown pty-live'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('same pty id, different incarnation is not the agent (row 11 path when that pty holds the leaf)', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a013'
    insertAgent(db, {
      id: 'agent-samepty-held',
      display_name: 'chair-samepty-held',
      pane_key: paneKey,
      process_incarnation: 'pty-same:inc-OLD'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-samepty-held',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-samepty-held',
        paneKey: 'tab8:00000000-0000-4000-8000-00000000f00e',
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    // The daemon relists 'pty-same' under a NEW incarnation — same OS-level ptyId, a different
    // process. The registered agent's own identity ('inc-OLD') does not match -> 'dead', never
    // 'alive'. That pty also holds the leaf (own-pane occupant) -> row 11.
    const inventory = emptyInventory({
      allLivePtyIds: new Set(['pty-same']),
      terminalIdentityByPtyId: new Map([
        ['pty-same', { handle: 'term_same', incarnationId: 'inc-NEW' }]
      ])
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        findConnectedLeafOccupant: () => ({ paneKey, ptyId: 'pty-same' }),
        ensureAgentSession
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-samepty-held',
      'pty-same:inc-OLD',
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      inventory
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
           AND reason_code = 'leaf_occupied_by_live_non_agent_pty pty-same'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('same pty id, different incarnation is not the agent (row 8 restore otherwise — that pty does NOT hold the leaf)', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a014'
    insertAgent(db, {
      id: 'agent-samepty-free',
      display_name: 'chair-samepty-free',
      pane_key: paneKey,
      process_incarnation: 'pty-same2:inc-OLD'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-samepty-free',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-samepty-free',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const inventory = emptyInventory({
      allLivePtyIds: new Set(['pty-same2']),
      terminalIdentityByPtyId: new Map([
        ['pty-same2', { handle: 'term_same2', incarnationId: 'inc-NEW' }]
      ])
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        // No occupant at all — this run point's `this.leaves` is a race, per D-R111 R2.
        findConnectedLeafOccupant: () => undefined,
        ensureAgentSession
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-samepty-free',
      'pty-same2:inc-OLD',
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      inventory
    )
    expect(outcome.kind).toBe('layer1')
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: { tabId: 'tab1', leafId: '00000000-0000-4000-8000-00000000a014' }
      }),
      {},
      expect.anything()
    )
  })

  it('one inventory round per sweep: three candidates share ONE takeControllerInventoryForSweep call', async () => {
    const db = rawDb()
    const paneKeys = [
      'tab1:00000000-0000-4000-8000-00000000b001',
      'tab1:00000000-0000-4000-8000-00000000b002',
      'tab1:00000000-0000-4000-8000-00000000b003'
    ]
    paneKeys.forEach((paneKey, i) => {
      insertAgent(db, {
        id: `agent-round-${i}`,
        display_name: `chair-round-${i}`,
        pane_key: paneKey
      })
      recordLaunch(db, {
        hostId: HOST_ID,
        paneKey,
        agentType: 'claude',
        sessionId: `sess-round-${i}`,
        launchGeneration: PRIOR_GEN,
        executionHostId: EXEC_HOST_ID,
        evidence: 'host_launch'
      })
    })
    const takeControllerInventoryForSweep = vi.fn(async () => emptyInventory())
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-round',
        paneKey: paneKeys[0],
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const summary = await runRestoreSweepBody(
      baseDeps(orchestrationDb!, { takeControllerInventoryForSweep, ensureAgentSession })
    )
    expect(summary.candidates).toBe(3)
    expect(takeControllerInventoryForSweep).toHaveBeenCalledTimes(1)
  })
})
