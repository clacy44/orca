// S10-21a C5 (design v3.2 §2.4; errata 5(p)-5 v2.1): the restore rebind — predicate and
// transaction, pure DB. T2, T5, T6, T9, T13 as §6.1 states them, plus two fences: the narrow
// UPDATE touches only its allowed columns, and no pact row is changed inside the transaction.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { rebindRestoredPane } from './agent-restore-rebind'
import { newestLaunchForPane, recordLaunch } from './agent-launch-sessions'
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

  // [S10-21a C5b] seeds an agent_launch_sessions row and returns its seq for launchSeq tickets.
  function seedLaunchRow(
    db: Database.Database,
    paneKey: string,
    sessionId = 'sess-r',
    agentId: string | null = null
  ): number {
    const result = recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId,
      launchGeneration: LAUNCH_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    if (!result.ok) {
      throw new Error('seedLaunchRow failed')
    }
    if (agentId !== null) {
      db.prepare(`UPDATE agent_launch_sessions SET agent_id = ? WHERE seq = ?`).run(
        agentId,
        result.row.seq
      )
    }
    return result.row.seq
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

    // The launch-row write (recordLaunchInTransaction, inside this same transaction) landed too.
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
    // retire, which makes this branch unreachable via that path; see the separate
    // retire-nulled-pane_key test below (Ruling 34 Addendum 16(a): RULED correct as-is).
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

  it(
    '[D-R107 MEDIUM-2, SCENARIO_CORRECTION] Ruling 34 Addendum 16(a): a retired predecessor ' +
      '(pane_key nulled) refuses and writes EXACTLY ONE audit row and nothing else. ' +
      'BEFORE (base 25558e4c8a): asserted `auditRows` (agent_id-scoped) toHaveLength(0) — ' +
      "'writes nothing'. AFTER (D-R107 fix item 14 / MEDIUM-2, loud-degradation rule): every " +
      'refusal reason now audits (agentId null here — no row was ever found to attribute it ' +
      'to), so the query is now actor_pane_key-scoped and asserts exactly one row, outcome ' +
      "'refused', reason_code naming 'predecessor_row_not_found'.",
    () => {
      const db = rawDb()
      // Mirrors retireAgent's own UPDATE (agent-retire.ts): pane_key nulled, tombstoned_at set.
      insertAgent(db, {
        id: 'agent-retired',
        display_name: 'chair-retired',
        pane_key: null,
        tombstoned_at: new Date().toISOString()
      })

      const result = rebindRestoredPane(db, {
        ticketPayload: ticketFor('tab1:leaf-retired'),
        newPaneKey: 'tab2:leaf-retired2',
        newTerminalHandle: null,
        hostId: HOST_ID,
        executionHostId: EXEC_HOST_ID,
        launchGeneration: LAUNCH_GEN,
        incumbent: DEAD_INCUMBENT
      })
      expect(result).toEqual({ ok: false, reason: 'predecessor_row_not_found' })

      const row = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-retired') as AgentRow
      expect(row.pane_key).toBeNull()
      const auditRows = db
        .prepare(`SELECT * FROM agent_audit WHERE actor_pane_key = ? AND verb = 'rebind'`)
        .all('tab2:leaf-retired2') as {
        agent_id: string | null
        outcome: string
        reason_code: string
      }[]
      expect(auditRows).toHaveLength(1)
      expect(auditRows[0].agent_id).toBeNull()
      expect(auditRows[0].outcome).toBe('refused')
      expect(auditRows[0].reason_code).toContain('predecessor_row_not_found')
      expect(newestLaunchForPane(db, HOST_ID, 'tab2:leaf-retired2')).toBeUndefined()
    }
  )

  it('Ruling 34 Addendum 16(c): foreign_session_id on the launch-row write rolls back the whole rebind', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agent-f',
      display_name: 'chair-f',
      pane_key: 'tab1:leaf-f',
      terminal_handle: 'handle-f'
    })
    // A different, unrelated pane already holds the session id the ticket names — a genuine
    // cross-pane collision, not the same-target restatement branch.
    db.prepare(`INSERT INTO current_sessions (host_id, pane_key, session_id) VALUES (?, ?, ?)`).run(
      HOST_ID,
      'tab3:leaf-other',
      'sess-r'
    )

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-f'),
      newPaneKey: 'tab2:leaf-f2',
      newTerminalHandle: 'handle-f2',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(result).toEqual({ ok: false, reason: 'launch_row_foreign_session_id' })

    // The whole rebind rolled back — agent row, mailboxes, threads all unchanged.
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-f') as AgentRow
    expect(row.pane_key).toBe('tab1:leaf-f')
    expect(row.terminal_handle).toBe('handle-f')
    // [D-R107 MEDIUM-2, SCENARIO_CORRECTION] BEFORE (base 25558e4c8a): asserted
    // `toHaveLength(0)` — this refusal was silent. AFTER (fix item 14): every refusal reason
    // now audits one row, outcome 'refused' — the rollback still leaves nothing ELSE behind.
    const auditRows = db
      .prepare(`SELECT * FROM agent_audit WHERE agent_id = ? AND verb = 'rebind'`)
      .all('agent-f') as { outcome: string; reason_code: string }[]
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].outcome).toBe('refused')
    expect(auditRows[0].reason_code).toContain('launch_row_foreign_session_id')
    expect(newestLaunchForPane(db, HOST_ID, 'tab2:leaf-f2')).toBeUndefined()
    // The predecessor's own current_sessions row (had there been one) is untouched by the
    // supersedePaneKey delete — nothing here to assert a row for since none was seeded, but the
    // unrelated pane's row must survive verbatim.
    const other = db
      .prepare('SELECT * FROM current_sessions WHERE host_id = ? AND pane_key = ?')
      .get(HOST_ID, 'tab3:leaf-other')
    expect(other).toBeDefined()
  })

  it('S10-21a C6, §2.6 SCOPE(a): conflicting_signals => contested audit, no rebind, row unchanged', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agent-c',
      display_name: 'chair-c',
      pane_key: 'tab1:leaf-c',
      terminal_handle: 'handle-c'
    })
    const conflictingSignals: IncumbentVerdict = { dead: false, reason: 'conflicting_signals' }

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-c'),
      newPaneKey: 'tab2:leaf-c2',
      newTerminalHandle: 'handle-c2',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: conflictingSignals
    })
    expect(result).toEqual({ ok: false, reason: 'incumbent_alive' })

    // Fail-closed: no rebind, no row change.
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-c') as AgentRow
    expect(row.pane_key).toBe('tab1:leaf-c')
    expect(row.terminal_handle).toBe('handle-c')

    const contested = db
      .prepare(
        `SELECT * FROM agent_audit WHERE agent_id = ? AND verb = 'rebind' AND outcome = 'contested'`
      )
      .all('agent-c') as { outcome: string; reason_code: string | null }[]
    expect(contested).toHaveLength(1)
    expect(contested[0].reason_code).toContain('conflicting_signals')
  })

  it('a plain live incumbent (no conflicting_signals) also raises the contested audit, per SCOPE(a)', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agent-l',
      display_name: 'chair-l',
      pane_key: 'tab1:leaf-l',
      terminal_handle: 'handle-l'
    })
    const liveIncumbent: IncumbentVerdict = { dead: false, reason: 'live' }

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-l'),
      newPaneKey: 'tab2:leaf-l2',
      newTerminalHandle: 'handle-l2',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: liveIncumbent
    })
    expect(result).toEqual({ ok: false, reason: 'incumbent_alive' })
    const contested = db
      .prepare(
        `SELECT * FROM agent_audit WHERE agent_id = ? AND verb = 'rebind' AND outcome = 'contested'`
      )
      .all('agent-l')
    expect(contested).toHaveLength(1)
  })

  it('S10-21a C5b, errata 5(z)/D-R107 HIGH-1: predecessor_moved via launchSeq — the launch row named by the ticket no longer sits on predecessorPaneKey', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agent-mv',
      display_name: 'chair-mv',
      pane_key: 'tab1:leaf-mv',
      terminal_handle: 'handle-mv'
    })
    // The seq the ticket names was minted for a DIFFERENT pane — simulating "the row moved
    // since the sweep read it" (the ticket's own snapshot is stale).
    const staleSeq = seedLaunchRow(db, 'tab9:leaf-elsewhere')

    const result = rebindRestoredPane(db, {
      ticketPayload: { ...ticketFor('tab1:leaf-mv'), launchSeq: staleSeq },
      newPaneKey: 'tab2:leaf-mv2',
      newTerminalHandle: 'handle-mv2',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(result).toEqual({ ok: false, reason: 'predecessor_moved' })

    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-mv') as AgentRow
    expect(row.pane_key).toBe('tab1:leaf-mv') // fail-closed: no rebind, no row change

    const audit = db
      .prepare(
        `SELECT * FROM agent_audit WHERE agent_id = ? AND verb = 'rebind' AND outcome = 'contested'`
      )
      .all('agent-mv')
    expect(audit).toHaveLength(1)
  })

  it('S10-21a C5b, D-R107 HIGH-1: id mismatch — a different registered agent occupies the suffix the ticket names, refused predecessor_moved', () => {
    const db = rawDb()
    // R (the row the ticket was minted for) — its launch row's agent_id.
    const seq = seedLaunchRow(db, 'tab1:leaf-shared', 'sess-r', 'agent-original')
    // A DIFFERENT registered agent now occupies that same pane suffix (e.g. a fresh registration
    // reused the leaf after the original retired-and-rejoined under a new id).
    insertAgent(db, {
      id: 'agent-impostor',
      display_name: 'chair-impostor',
      pane_key: 'tab1:leaf-shared',
      terminal_handle: 'handle-impostor'
    })

    const result = rebindRestoredPane(db, {
      ticketPayload: { ...ticketFor('tab1:leaf-shared'), launchSeq: seq },
      newPaneKey: 'tab2:leaf-shared2',
      newTerminalHandle: 'handle-shared2',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(result).toEqual({ ok: false, reason: 'predecessor_moved' })

    const impostorRow = db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get('agent-impostor') as AgentRow
    expect(impostorRow.pane_key).toBe('tab1:leaf-shared') // never rebound onto the new pane
  })

  it('S10-21a C5b, Ruling 34 Addendum 18(v): a launch row the admission already wrote for THIS restore is recognised (restated), not duplicated — agent_id binds to it', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agent-rs',
      display_name: 'chair-rs',
      pane_key: 'tab1:leaf-rs',
      terminal_handle: 'handle-rs'
    })
    // Simulates agent-launch-admission.ts's HOST_RESUME branch already having written the new
    // pane's row at spawn — evidence 'sweep_record', supersedePaneKey = predecessorPaneKey —
    // before the sweep ever calls rebindRestoredPane for the SAME move.
    const admissionWrite = recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: 'tab2:leaf-rs2',
      agentType: 'claude',
      sessionId: 'sess-r',
      launchGeneration: LAUNCH_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'sweep_record',
      supersedePaneKey: 'tab1:leaf-rs'
    })
    if (!admissionWrite.ok) {
      throw new Error('setup failed')
    }
    const rowCountBefore = (
      db
        .prepare(`SELECT COUNT(*) as n FROM agent_launch_sessions WHERE pane_key = ?`)
        .get('tab2:leaf-rs2') as { n: number }
    ).n
    expect(rowCountBefore).toBe(1)

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-rs'),
      newPaneKey: 'tab2:leaf-rs2',
      newTerminalHandle: 'handle-rs2',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(result.ok).toBe(true)
    if (!result.ok || !result.rebound) {
      throw new Error('expected a completed rebind')
    }

    // No duplicate row — the admission's own row was recognised and bound, not re-inserted.
    const rowCountAfter = (
      db
        .prepare(`SELECT COUNT(*) as n FROM agent_launch_sessions WHERE pane_key = ?`)
        .get('tab2:leaf-rs2') as { n: number }
    ).n
    expect(rowCountAfter).toBe(1)
    const launchRow = newestLaunchForPane(db, HOST_ID, 'tab2:leaf-rs2')
    expect(launchRow?.seq).toBe(admissionWrite.row.seq)
    expect(launchRow?.agent_id).toBe('agent-rs')
  })

  it('S10-21a C5b, D-R107 fix item 14/MEDIUM-2: every predicate refusal reason writes exactly one audit row', () => {
    const db = rawDb()

    // ticket_stale_generation
    insertAgent(db, { id: 'a-1', display_name: 'c-1', pane_key: 'tab1:leaf-1' })
    const staleGen = rebindRestoredPane(db, {
      ticketPayload: { ...ticketFor('tab1:leaf-1'), launchGeneration: 'stale-gen' },
      newPaneKey: 'tab2:leaf-1b',
      newTerminalHandle: null,
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(staleGen).toEqual({ ok: false, reason: 'ticket_stale_generation' })

    // row_quarantined (host_mismatch is DEAD CODE, not exercised here: findRowByPaneSuffix's
    // own WHERE clause already filters on host_id, so a row with a different host_id is never
    // found at all — it refuses predecessor_row_not_found before clause 5 can run. Pre-existing,
    // outside this brief's fix list; noted in the RETURN block as a residual finding.)
    insertAgent(db, {
      id: 'a-2',
      display_name: 'c-2',
      pane_key: 'tab1:leaf-2',
      quarantined: 1,
      quarantined_at: new Date().toISOString()
    })
    const quarRefusal = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-2'),
      newPaneKey: 'tab2:leaf-2b',
      newTerminalHandle: null,
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(quarRefusal).toEqual({ ok: false, reason: 'row_quarantined' })

    // target_leaf_occupied
    insertAgent(db, { id: 'a-3', display_name: 'c-3', pane_key: 'tab1:leaf-3' })
    insertAgent(db, { id: 'a-3-occ', display_name: 'c-3-occ', pane_key: 'tab2:leaf-3occ' })
    const occupied = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-3'),
      newPaneKey: 'tab2:leaf-3occ',
      newTerminalHandle: null,
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(occupied).toEqual({ ok: false, reason: 'target_leaf_occupied' })

    for (const [paneKey, reason] of [
      ['tab2:leaf-1b', 'ticket_stale_generation'],
      ['tab2:leaf-2b', 'row_quarantined'],
      ['tab2:leaf-3occ', 'target_leaf_occupied']
    ] as const) {
      const rows = db
        .prepare(`SELECT * FROM agent_audit WHERE actor_pane_key = ? AND verb = 'rebind'`)
        .all(paneKey) as { outcome: string; reason_code: string }[]
      expect(rows).toHaveLength(1)
      expect(rows[0].outcome).toBe('refused')
      expect(rows[0].reason_code).toContain(reason)
    }
  })

  it('S10-21a C5b, D-R107 MEDIUM-4: quarantined-predecessor honesty — blockedByQuarantinedPredecessor surfaces true, not a bare 0', () => {
    const db = rawDb()
    // A quarantined predecessor sharing the successor's display_name blocks H6 catch-up
    // outright (agent-thread-succession.ts's own F-9 reasoning).
    insertAgent(db, {
      id: 'agent-quar-pred',
      display_name: 'chair-shared-name',
      pane_key: 'tab9:leaf-quarantined-pred',
      quarantined: 1,
      quarantined_at: new Date().toISOString(),
      tombstoned_at: new Date().toISOString()
    })
    insertAgent(db, {
      id: 'agent-successor',
      display_name: 'chair-shared-name',
      pane_key: 'tab1:leaf-succ',
      terminal_handle: 'handle-succ'
    })

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-succ'),
      newPaneKey: 'tab2:leaf-succ2',
      newTerminalHandle: 'handle-succ2',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT
    })
    expect(result.ok).toBe(true)
    if (!result.ok || !result.rebound) {
      throw new Error('expected a completed rebind')
    }
    expect(result.blockedByQuarantinedPredecessor).toBe(true)
    expect(result.adoptedThreads).toBe(0)
  })
})
