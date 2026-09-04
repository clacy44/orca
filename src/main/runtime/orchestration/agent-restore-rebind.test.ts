// S10-21a C5 (design v3.2 §2.4; errata 5(p)-5 v2.1): the restore rebind — predicate and
// transaction, pure DB. T2, T5, T6, T9, T13 as §6.1 states them, plus two fences: the narrow
// UPDATE touches only its allowed columns, and no pact row is changed inside the transaction.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { rebindRestoredPane } from './agent-restore-rebind'
import { newestLaunchForPane } from './agent-launch-sessions'
import type { RestoreTicketPayload } from '../restore-ticket-registry'
import type { IncumbentVerdict } from '../incumbent-death'
import { OrchestrationDb } from './db'
import type { AgentRow } from './types'

const HOST_ID = 'local'
const EXEC_HOST_ID = 'local'
const LAUNCH_GEN = 'gen-1'

const DEAD_INCUMBENT: IncumbentVerdict = {
  dead: true,
  signal: 'D1',
  evidence: {
    paneKey: 'tab1:leaf-a',
    d1: { ptyKnownToRuntime: false, exitObservedThisGeneration: true },
    d2: { inventory: 'unknown' },
    d3: { liveNow: false, firstObservedNotLiveAt: null, now: 0 }
  }
}

describe('S10-21a C5: rebindRestoredPane', () => {
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
       ) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'idle', ?, ?, ?, ?,
         'pane', ?, ?, ?)`
    ).run(
      overrides.id,
      overrides.display_name,
      overrides.host_id ?? HOST_ID,
      overrides.pane_key,
      overrides.terminal_handle ?? null,
      overrides.derived ?? 0,
      overrides.quarantined ?? 0,
      overrides.quarantined_at ?? null,
      overrides.tombstoned_at ?? null,
      overrides.pane_key,
      overrides.terminal_handle ?? null,
      overrides.origin_host_id ?? HOST_ID
    )
  }

  function ticketFor(predecessorPaneKey: string, execHostId = EXEC_HOST_ID): RestoreTicketPayload {
    return {
      predecessorPaneKey,
      sessionId: 'sess-r',
      executionHostId: execHostId,
      launchGeneration: LAUNCH_GEN
    }
  }

  it('T2: Layer 2 rebind moves pane_key, leaves id/display_name unchanged, writes one rebind audit row', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agent-r',
      display_name: 'chair-r',
      pane_key: 'tab1:leaf-pred',
      terminal_handle: 'handle-pred'
    })

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-pred'),
      newPaneKey: 'tab2:leaf-new',
      newTerminalHandle: 'handle-new',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })

    expect(result.ok).toBe(true)
    if (!result.ok || !result.rebound) {
      throw new Error('expected a completed rebind')
    }
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-r') as AgentRow
    expect(row.pane_key).toBe('tab2:leaf-new')
    expect(row.terminal_handle).toBe('handle-new')
    expect(row.id).toBe('agent-r')
    expect(row.display_name).toBe('chair-r')

    const auditRows = db
      .prepare(`SELECT * FROM agent_audit WHERE agent_id = ? AND verb = 'rebind'`)
      .all('agent-r') as { outcome: string }[]
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].outcome).toBe('reminted')

    // The launch-row write (recordLaunch, post-commit) landed too.
    const launchRow = newestLaunchForPane(db, HOST_ID, 'tab2:leaf-new')
    expect(launchRow?.session_id).toBe('sess-r')
    expect(launchRow?.agent_id).toBe('agent-r')
  })

  it('T5: quarantined / tombstoned / retired row => no rebind, all three', () => {
    const db = rawDb()

    insertAgent(db, {
      id: 'agent-q',
      display_name: 'chair-q',
      pane_key: 'tab1:leaf-q',
      quarantined: 1,
      quarantined_at: new Date().toISOString()
    })
    const quarantined = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-q'),
      newPaneKey: 'tab2:leaf-q2',
      newTerminalHandle: null,
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(quarantined).toEqual({ ok: false, reason: 'row_quarantined' })

    // Tombstoned but still pane-keyed (idx_agents_pane_suffix's UNIQUE excludes tombstoned rows
    // via its WHERE clause, so this fixture is legal) — retireAgent nulls pane_key on a real
    // retire, which makes this branch unreachable via that path; see the RETURN block's open
    // question on `T.agentId`.
    insertAgent(db, {
      id: 'agent-t',
      display_name: 'chair-t',
      pane_key: 'tab1:leaf-t',
      tombstoned_at: new Date().toISOString()
    })
    const tombstoned = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-t'),
      newPaneKey: 'tab2:leaf-t2',
      newTerminalHandle: null,
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(tombstoned).toEqual({ ok: false, reason: 'row_tombstoned' })

    insertAgent(db, {
      id: 'agent-d',
      display_name: 'chair-d',
      pane_key: 'tab1:leaf-d',
      derived: 1
    })
    const derived = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-d'),
      newPaneKey: 'tab2:leaf-d2',
      newTerminalHandle: null,
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(derived).toEqual({ ok: false, reason: 'row_derived' })
  })

  it('T6: cross-execution-host ticket => no rebind', () => {
    const db = rawDb()
    insertAgent(db, { id: 'agent-x', display_name: 'chair-x', pane_key: 'tab1:leaf-x' })

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-x', 'remote-host'),
      newPaneKey: 'tab2:leaf-x2',
      newTerminalHandle: null,
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(result).toEqual({ ok: false, reason: 'cross_execution_host' })
  })

  it('T9: a registered row already on the target pane => no rebind', () => {
    const db = rawDb()
    insertAgent(db, { id: 'agent-p', display_name: 'chair-p', pane_key: 'tab1:leaf-p' })
    insertAgent(db, { id: 'agent-occupant', display_name: 'chair-occ', pane_key: 'tab2:leaf-occ' })

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-p'),
      newPaneKey: 'tab2:leaf-occ',
      newTerminalHandle: null,
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(result).toEqual({ ok: false, reason: 'target_leaf_occupied' })
  })

  it('T13: idempotence — a double fire writes one audit row and one UPDATE', () => {
    const db = rawDb()
    insertAgent(db, { id: 'agent-i', display_name: 'chair-i', pane_key: 'tab1:leaf-i' })

    const params = {
      ticketPayload: ticketFor('tab1:leaf-i'),
      newPaneKey: 'tab2:leaf-i2',
      newTerminalHandle: 'handle-i2',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    }
    const first = rebindRestoredPane(db, params)
    expect(first.ok).toBe(true)
    if (!first.ok || !first.rebound) {
      throw new Error('expected the first call to complete the rebind')
    }

    const second = rebindRestoredPane(db, params)
    expect(second).toEqual({ ok: true, rebound: false, agentId: 'agent-i' })

    const auditRows = db
      .prepare(`SELECT * FROM agent_audit WHERE agent_id = ? AND verb = 'rebind'`)
      .all('agent-i')
    expect(auditRows).toHaveLength(1)

    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-i') as AgentRow
    expect(row.pane_key).toBe('tab2:leaf-i2')
  })

  it('fence: the narrow UPDATE touches only pane_key/terminal_handle/last_seen_at', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agent-n',
      display_name: 'chair-n',
      pane_key: 'tab1:leaf-n',
      terminal_handle: 'handle-n'
    })
    const before = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-n') as AgentRow

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-n'),
      newPaneKey: 'tab2:leaf-n2',
      newTerminalHandle: 'handle-n2',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(result.ok).toBe(true)

    const after = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-n') as AgentRow
    const changedKeys = (Object.keys(before) as (keyof AgentRow)[]).filter(
      (key) => before[key] !== after[key]
    )
    // last_seen_at is datetime('now') at 1-second resolution, so it may or may not differ from
    // `before` depending on wall-clock timing within the test run — assert it is allowed to
    // change (never asserted absent) while every OTHER changed key is exactly the two the narrow
    // UPDATE is specified to touch.
    expect(new Set(changedKeys.filter((key) => key !== 'last_seen_at'))).toEqual(
      new Set(['pane_key', 'terminal_handle'])
    )
    expect(after.pane_key).toBe('tab2:leaf-n2')
    expect(after.terminal_handle).toBe('handle-n2')
  })

  it('fence: no pact row is changed inside the transaction', () => {
    const db = rawDb()
    insertAgent(db, { id: 'agent-pact', display_name: 'chair-pact', pane_key: 'tab1:leaf-pact' })
    insertAgent(db, { id: 'agent-peer', display_name: 'chair-peer', pane_key: 'tab1:leaf-peer' })
    db.prepare(
      `INSERT INTO threads (
         id, subject, pact_with_agent_id, pact_state, pact_proposer_agent_id, pact_paused_at,
         pact_pause_reason
       ) VALUES ('thr-1', 'pact', 'agent-peer', 'engaged', 'agent-pact', datetime('now'),
         'counterpart_gone')`
    ).run()
    const before = db.prepare('SELECT * FROM threads WHERE id = ?').get('thr-1')

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-pact'),
      newPaneKey: 'tab2:leaf-pact2',
      newTerminalHandle: null,
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(result.ok).toBe(true)
    if (!result.ok || !result.rebound) {
      throw new Error('expected a completed rebind')
    }
    expect(result.pactsToUnpause).toEqual(['thr-1'])

    const after = db.prepare('SELECT * FROM threads WHERE id = ?').get('thr-1')
    expect(after).toEqual(before)
  })
})
