// S10-21a C5 pact fixtures, split out of agent-restore-rebind.test.ts (max-lines ratchet, 800
// cap) when S10-21b B17b (O-21b-46) added the host pause ledger row these two fixtures need.
// Assertions are byte-identical to their pre-split versions; only setup and location moved.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { rebindRestoredPane } from './agent-restore-rebind'
import type { RestoreTicketPayload } from '../restore-ticket-registry'
import type { IncumbentVerdict } from '../incumbent-death'
import { OrchestrationDb } from './db'
import type { AgentRow } from './types'
import { insertPactStepRow } from './pact-shared'

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

describe('S10-21a C5: rebindRestoredPane — pact fixtures', () => {
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

  // [O-21b-46] seeds a real host pause ledger row for a counterpart_gone fixture.
  function seedHostPauseRow(db: Database.Database, threadId: string): void {
    insertPactStepRow(db, {
      threadId,
      ordinal: 0,
      kind: 'pause',
      actorAgentId: null,
      actorPaneKey: null,
      actorHostId: null,
      messageId: null,
      summary: null,
      turnAfterAgentId: null,
      reasonCode: 'counterpart_gone'
    })
  }

  function ticketFor(predecessorPaneKey: string, execHostId = EXEC_HOST_ID): RestoreTicketPayload {
    return {
      predecessorPaneKey,
      sessionId: 'sess-r',
      executionHostId: execHostId,
      launchGeneration: LAUNCH_GEN
    }
  }

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
    // [SCENARIO_CORRECTION, O-21b-46] seed the host pause row via the real producer helper.
    seedHostPauseRow(db, 'thr-1')
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

  it('[S10-21a C7l item 8, C10 gap, D-R118 F7] a same-pane (noop) restore with a counterpart_gone-paused pact carries pactsToUnpause out', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agent-same-pact',
      display_name: 'chair-same-pact',
      pane_key: 'tab1:leaf-same-pact',
      terminal_handle: 'handle-old'
    })
    insertAgent(db, {
      id: 'agent-peer-pact',
      display_name: 'chair-peer-pact',
      pane_key: 'tab1:leaf-peer-pact'
    })
    db.prepare(
      `INSERT INTO threads (
         id, subject, pact_with_agent_id, pact_state, pact_proposer_agent_id, pact_paused_at,
         pact_pause_reason
       ) VALUES ('thr-same-1', 'pact', 'agent-peer-pact', 'engaged', 'agent-same-pact',
         datetime('now'), 'counterpart_gone')`
    ).run()
    // [SCENARIO_CORRECTION, O-21b-46] seed the host pause row via the real producer helper.
    seedHostPauseRow(db, 'thr-same-1')

    // FAILS AT BASE: the noop (same-pane) branch discards refreshAgentHandleAfterRespawn's own
    // pactsToUnpause entirely — the result never carried this field at all.
    const result = rebindRestoredPane(db, {
      ticketPayload: ticketFor('tab1:leaf-same-pact'),
      newPaneKey: 'tab1:leaf-same-pact',
      newTerminalHandle: 'handle-new',
      hostId: HOST_ID,
      executionHostId: EXEC_HOST_ID,
      launchGeneration: LAUNCH_GEN,
      incumbent: DEAD_INCUMBENT,
      // [S10-21c B-final F1, D-R159 finding 1, SCENARIO_CORRECTION] UUID-shaped incarnation id —
      // the new explicit shape check requires one before the refresh (and its pact-unpause) runs.
      processIncarnation: 'pty-same-pact:12121212-1212-4121-8121-212121212121'
    })
    expect(result).toEqual({
      ok: true,
      rebound: false,
      agentId: 'agent-same-pact',
      pactsToUnpause: ['thr-same-1']
    })
  })
})
