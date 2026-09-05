// S10-21a C7m (Ruling 34 Addendum 30, item 2; D-R120): the Layer-2 rebind's own UPDATE (step 2)
// never writes an unparseable/legacy processIncarnation — same refusal shape as the noop
// (Layer-1) path's own guard. Split from agent-restore-rebind.test.ts (which sits at the
// 800-line test cap) — same fixture helpers, copied minimally.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { rebindRestoredPane } from './agent-restore-rebind'
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

describe('S10-21a C7m item 2: rebindRestoredPane Layer-2 identity guard', () => {
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

  it('a Layer-2 rebind with processIncarnation NULL leaves the column untouched, notes identity_unavailable_at_refresh: null (fails at base)', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agent-l2-null',
      display_name: 'chair-l2-null',
      pane_key: 'tab1:leaf-l2-null-old',
      terminal_handle: 'handle-l2-null-old'
    })

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-l2-null-old'),
      newPaneKey: 'tab2:leaf-l2-null-new',
      newTerminalHandle: 'handle-l2-null-new',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT,
      processIncarnation: null
    })
    expect(result.ok).toBe(true)

    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-l2-null') as AgentRow
    expect(row.process_incarnation).toBeNull()
    expect(row.pane_key).toBe('tab2:leaf-l2-null-new')

    const noteRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE agent_id = ? AND verb = 'sweep_note'
           AND reason_code = 'identity_unavailable_at_refresh: null'`
      )
      .all('agent-l2-null')
    expect(noteRows).toHaveLength(1)
  })

  it('a Layer-2 rebind with a LEGACY 3-segment processIncarnation leaves the column untouched, notes identity_unavailable_at_refresh: unparseable (fails at base)', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agent-l2-legacy',
      display_name: 'chair-l2-legacy',
      pane_key: 'tab1:leaf-l2-legacy-old',
      terminal_handle: 'handle-l2-legacy-old'
    })

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-l2-legacy-old'),
      newPaneKey: 'tab2:leaf-l2-legacy-new',
      newTerminalHandle: 'handle-l2-legacy-new',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT,
      processIncarnation: 'runtime-1:pty-1:gen-1'
    })
    expect(result.ok).toBe(true)

    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-l2-legacy') as AgentRow
    expect(row.process_incarnation).toBeNull()

    const noteRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE agent_id = ? AND verb = 'sweep_note'
           AND reason_code = 'identity_unavailable_at_refresh: unparseable'`
      )
      .all('agent-l2-legacy')
    expect(noteRows).toHaveLength(1)
  })
})
