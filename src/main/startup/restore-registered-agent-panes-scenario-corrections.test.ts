// S10-21a C7i (Ruling 34 Addendum 27, D-R116 REJECT of C7h): SCENARIO_CORRECTIONS — d1/d2/d3 are
// no longer a survival arm, and an own-pane occupant is judged by ptyState of ITS OWN ptyId,
// never a ptyId-mismatch-plus-ptyLive comparison. Split out of
// restore-registered-agent-panes-decision-table.test.ts to stay under the max-lines ratchet. See
// the commit body for the removed/changed assertion lines quoted verbatim.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import type { RestoreTicketId, RestoreTicketMintArgs } from '../runtime/restore-ticket-registry'
import { restoreOneRegisteredPane } from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'
import {
  HOST_ID,
  EXEC_HOST_ID,
  PRIOR_GEN,
  emptyInventory,
  insertAgent,
  baseDeps
} from './restore-sweep-test-fixtures'

describe('S10-21a C7i: SCENARIO_CORRECTIONS (Ruling 34 Addendum 27, D-R116 REJECT of C7h)', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  it('SCENARIO_CORRECTION (C7i, was C7h Addendum 26): an own-pane occupant with the SAME pty as the row and ABSENT from the round is a stale surface, restored over — not a survival verdict', async () => {
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
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-3',
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
      'agent-3',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer1')
    expect(mintRestoreTicket).toHaveBeenCalled()
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: { tabId: 'tab1', leafId: '00000000-0000-4000-8000-000000000003' }
      }),
      {},
      expect.anything()
    )
    const skipRows = db.prepare(`SELECT * FROM agent_audit WHERE verb = 'sweep_skip'`).all()
    expect(skipRows).toHaveLength(0)
    // SCENARIO_CORRECTION: was `reason_code = 'stale_own_surface: D1'` (the resolveIncumbentDeath
    // D1/D2/D3 signal) — D1/D2/D3 are no longer read for this decision at all; the new reason
    // names the ptyState fact directly.
    const noteRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_note'
           AND reason_code = 'stale_own_surface: occupant_pty_absent_from_inventory pty-own'`
      )
      .all()
    expect(noteRows).toHaveLength(1)
  })

  it('SCENARIO_CORRECTION (C7i, was C7h Addendum 26): an own-pane occupant on a DIFFERENT pty PRESENT in the round is never yielded to and never spawned over — restores to a FRESH pane, no placement (not skipped)', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000dddd'
    insertAgent(db, { id: 'agent-leafheld', display_name: 'chair-leafheld', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-leafheld',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-leafheld',
        paneKey: 'tab7:00000000-0000-4000-8000-00000000f00d',
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
        getPersistedPtyIdForLeaf: () => 'pty-row',
        findConnectedLeafOccupant: () => ({ paneKey, ptyId: 'pty-fresh' }),
        ensureAgentSession,
        mintRestoreTicket
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-leafheld',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory({ allLivePtyIds: new Set(['pty-fresh']) })
    )
    // SCENARIO_CORRECTION: was `outcome.kind === 'skipped_leaf_held'`, `mintRestoreTicket` and
    // `ensureAgentSession` NOT called, and `reason_code = 'leaf_held_by_live_pty'` — under
    // Ruling 34 Addendum 27 a live-but-not-the-agent pty is restored around, never yielded to.
    expect(outcome.kind).toBe('layer2')
    expect(mintRestoreTicket).toHaveBeenCalled()
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ placement: undefined }),
      {},
      expect.anything()
    )
    // [S10-21a C7l, Ruling 34 Addendum 29 item 5, N4, SCENARIO_CORRECTION] Was
    // 'leaf_occupied_by_live_non_agent_pty pty-fresh' — this candidate's `processIncarnation`
    // is `null`, so its identity status is `unknown_no_identity`, never provably 'dead'.
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_note'
           AND reason_code = 'leaf_occupied_by_live_pty_identity_unknown pty-fresh'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('SCENARIO_CORRECTION (C7i, was C7h Addendum 26): same-id daemon respawn survives ONLY when the incarnation also matches — a different incarnation under the same ptyId is dead, not survived', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000eeee'
    insertAgent(db, {
      id: 'agent-respawn',
      display_name: 'chair-respawn',
      pane_key: paneKey,
      process_incarnation: 'pty-respawn:inc-OLD'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-respawn',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-respawn',
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
    // The daemon lists the SAME ptyId again, but under a NEW incarnation (a respawn) — under the
    // old D1/D2 arms (exit-observed AND inventory-present) this used to read as survived.
    const inventory = emptyInventory({
      allLivePtyIds: new Set(['pty-respawn']),
      terminalIdentityByPtyId: new Map([
        ['pty-respawn', { handle: 'term_respawn', incarnationId: 'inc-NEW' }]
      ])
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        getPersistedPtyIdForLeaf: () => 'pty-respawn',
        findConnectedLeafOccupant: () => undefined,
        ensureAgentSession,
        mintRestoreTicket
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-respawn',
      'pty-respawn:inc-OLD',
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      inventory
    )
    // SCENARIO_CORRECTION: was `outcome.kind === 'skipped_daemon_survived'`, `mintRestoreTicket`
    // NOT called, `ensureAgentSession` NOT called, `reason_code = 'daemon_survived:
    // d2_inventory_present'` — under Ruling 34 Addendum 27 a pty with the same id but ANOTHER
    // incarnation is provably not the agent: 'dead', restored over (Layer 1, same pane, no
    // occupant recorded by `findConnectedLeafOccupant` here).
    expect(outcome.kind).toBe('layer1')
    expect(mintRestoreTicket).toHaveBeenCalled()
    expect(ensureAgentSession).toHaveBeenCalled()
  })

  it('SCENARIO_CORRECTION (C7i, was D-R111 R2/C7e): D3 liveNow alone no longer fires daemon_survived — d1/d2/d3 are evidence-only now, never a survival arm', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000aaaa'
    insertAgent(db, { id: 'agent-r2', display_name: 'chair-r2', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-r2',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-r2',
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
        findConnectedLeafOccupant: () => undefined,
        ensureAgentSession,
        mintRestoreTicket
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-r2',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory()
    )
    // SCENARIO_CORRECTION: was `outcome.kind === 'skipped_daemon_survived'` from a fixture
    // reporting `d3: { liveNow: true, ... }` with no identity match at all — that fixture shape
    // is now impossible to honor as a survival, since d3 is no longer read for this decision.
    expect(outcome.kind).toBe('layer1')
    expect(mintRestoreTicket).toHaveBeenCalled()
    expect(ensureAgentSession).toHaveBeenCalled()
  })

  it('SCENARIO_CORRECTION (C7i, was D-R111 R2/C7e): a runtime-known pty (old D1) alone, with no identity match, no longer fires daemon_survived', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000bbbb'
    insertAgent(db, { id: 'agent-r2b', display_name: 'chair-r2b', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-r2b',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-r2b',
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
        findConnectedLeafOccupant: () => undefined,
        ensureAgentSession,
        mintRestoreTicket
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-r2b',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory()
    )
    // SCENARIO_CORRECTION: was `outcome.kind === 'skipped_daemon_survived'` with `mintRestoreTicket`
    // NOT called, from a fixture reporting `d1: { ptyKnownToRuntime: true, ... }` alone.
    expect(outcome.kind).toBe('layer1')
    expect(mintRestoreTicket).toHaveBeenCalled()
  })

  it("SCENARIO_CORRECTION (C7i, was D-R111 R2/C7g): D2 'present' alone, with no identity match, no longer fires daemon_survived", async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000cccc'
    insertAgent(db, { id: 'agent-r2c', display_name: 'chair-r2c', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-r2c',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-r2c',
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
        findConnectedLeafOccupant: () => undefined,
        ensureAgentSession,
        mintRestoreTicket
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-r2c',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory()
    )
    // SCENARIO_CORRECTION: was `outcome.kind === 'skipped_daemon_survived'`, `mintRestoreTicket`
    // and `ensureAgentSession` NOT called, `reason_code = 'daemon_survived: d2_inventory_present'`
    // — from a fixture reporting `d2: { inventory: 'present' }` with no identity match at all.
    expect(outcome.kind).toBe('layer1')
    expect(mintRestoreTicket).toHaveBeenCalled()
    expect(ensureAgentSession).toHaveBeenCalled()
  })
})
