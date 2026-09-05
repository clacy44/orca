// S10-21a C14b (D-R128 F4): the clause-3 noop (same-pane) restore path returns before ever
// calling `setLaunchAgentId` on the admission's own `sweep_record` row, so that row's `agent_id`
// stays NULL and `paneAwaitingSweepRestore` reports `sweep_record_pending_rebind` for the rest of
// the generation. Split from agent-restore-rebind.test.ts (already at the 800-line test cap).
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { rebindRestoredPane } from './agent-restore-rebind'
import { recordLaunch } from './agent-launch-sessions'
import type { RestoreTicketPayload } from '../restore-ticket-registry'
import type { IncumbentVerdict } from '../incumbent-death'
import { OrchestrationDb } from './db'
import type { AgentRow } from './types'

const HOST_ID = 'local'
const EXEC_HOST_ID = 'local'
const LAUNCH_GEN = 'gen-1'
const SESSION_ID = 'sess-f4'

const DEAD_INCUMBENT: IncumbentVerdict = {
  dead: true,
  signal: 'D1',
  evidence: {
    paneKey: 'tab1:leaf-f4',
    d1: { ptyKnownToRuntime: false, exitObservedThisGeneration: true },
    d2: { inventory: 'unknown' },
    d3: { liveNow: false, firstObservedNotLiveAt: null, now: 0 }
  }
}

describe('S10-21a C14b, D-R128 F4: the noop (same-pane) restore binds the admission own sweep_record row', () => {
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

  function ticketFor(predecessorPaneKey: string): RestoreTicketPayload {
    return {
      predecessorPaneKey,
      sessionId: SESSION_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN
    }
  }

  it('binds the admission sweep_record row agent_id on a same-pane noop restore (FAILS AT BASE: returns before setLaunchAgentId)', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agent-f4',
      display_name: 'chair-f4',
      pane_key: 'tab1:leaf-f4',
      terminal_handle: 'handle-old-f4'
    })
    // The admission's own sweep_record row for THIS restore — same session id, same generation,
    // same execution host, matching `isAdmissionsOwnRow`'s recognise-first-never-reinsert check.
    const seeded = recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-f4',
      agentType: 'claude',
      sessionId: SESSION_ID,
      launchGeneration: LAUNCH_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'sweep_record'
    })
    if (!seeded.ok) {
      throw new Error('seed sweep_record row failed')
    }
    expect(seeded.row.agent_id).toBeNull()

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-f4'),
      newPaneKey: 'tab1:leaf-f4',
      newTerminalHandle: 'handle-new-f4',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT,
      processIncarnation: 'pty-f4:inc-new'
    })
    expect(result).toEqual({ ok: true, rebound: false, agentId: 'agent-f4' })

    const launchRow = db
      .prepare(`SELECT agent_id FROM agent_launch_sessions WHERE seq = ?`)
      .get(seeded.row.seq) as { agent_id: string | null }
    // FAILS AT BASE (be7a229c76): the noop branch returns before step 5's setLaunchAgentId, so
    // this row's agent_id stays NULL and paneAwaitingSweepRestore wedges on
    // 'sweep_record_pending_rebind' for the rest of the generation.
    expect(launchRow.agent_id).toBe('agent-f4')
  })

  it('does NOT bind a mismatched (stale generation) sweep_record row on a same-pane noop restore', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agent-f4-stale',
      display_name: 'chair-f4-stale',
      pane_key: 'tab1:leaf-f4-stale',
      terminal_handle: 'handle-old-f4-stale'
    })
    const seeded = recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-f4-stale',
      agentType: 'claude',
      sessionId: SESSION_ID,
      launchGeneration: 'gen-stale',
      executionHostId: EXEC_HOST_ID,
      evidence: 'sweep_record'
    })
    if (!seeded.ok) {
      throw new Error('seed sweep_record row failed')
    }

    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-f4-stale'),
      newPaneKey: 'tab1:leaf-f4-stale',
      newTerminalHandle: 'handle-new-f4-stale',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT,
      processIncarnation: 'pty-f4-stale:inc-new'
    })
    expect(result).toEqual({ ok: true, rebound: false, agentId: 'agent-f4-stale' })

    const launchRow = db
      .prepare(`SELECT agent_id FROM agent_launch_sessions WHERE seq = ?`)
      .get(seeded.row.seq) as { agent_id: string | null }
    expect(launchRow.agent_id).toBeNull()
  })
})
