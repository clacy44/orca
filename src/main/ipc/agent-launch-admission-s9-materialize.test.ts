// S10-21d b6 (R119 fix, diag-r119-2026-09-08.md TEST 4): a desktop-shaped fixture — the exact
// topology the diagnosis's real box exhibited (3 registered panes each replaying an S9 relaunch
// of their OWN newest recorded id, plus 1 pane with only a `host_launch` row and no registered
// agent). Before FIX 1, every registered pane's own-id replay wrongly wrote a
// notice+contestedLineage; this fixture pins the corrected shape: per-registered-pane exactly
// ONE `launch_self_resume`/admitted row, the unregistered pane is admitted too, and NO
// `launch`/'contested' row is ever written.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { admitAgentLaunch, type LaunchAdmission } from './agent-launch-admission'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type * as NodeCrypto from 'node:crypto'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>()
  return { ...actual, randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000000') }
})

const HOST_ID = 'local'
const CALLER: LaunchAdmission = { kind: 'caller' }

describe('S10-21d b6, R119 fix: desktop fixture — 3 registered panes + 1 unregistered host_launch pane, each replaying its own newest id', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db.close()
  })

  function rawDb(orchestrationDb: OrchestrationDb): Database.Database {
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function insertRegisteredAgent(paneKey: string): void {
    rawDb(db)
      .prepare(
        `INSERT INTO agents (
           id, display_name, host_id, pane_key, origin_kind, origin_pane_key, origin_host_id
         ) VALUES (?, ?, ?, ?, 'pane', ?, ?)`
      )
      .run(`agt_${paneKey}`, `disp-${paneKey}`, HOST_ID, paneKey, paneKey, HOST_ID)
  }

  function opts(paneKey: string, sessionId: string): PtySpawnOptions {
    return {
      cols: 80,
      rows: 24,
      launchAgent: 'claude',
      paneKey,
      command: `claude --resume ${sessionId}`
    }
  }

  function ctx() {
    return {
      hostId: HOST_ID,
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      notice: () => {},
      contestedLineage: () => {}
    }
  }

  it('per registered pane exactly [launch_self_resume/admitted]; the unregistered pane is admitted too; no contested rows', async () => {
    db = new OrchestrationDb(':memory:')

    const registeredPanes = [
      { paneKey: 'tab1:leaf-a', sessionId: 'sess-a' },
      { paneKey: 'tab2:leaf-b', sessionId: 'sess-b' },
      { paneKey: 'tab3:leaf-c', sessionId: 'sess-c' }
    ]
    const unregisteredPane = { paneKey: 'tab4:leaf-d', sessionId: 'sess-d' }

    for (const pane of [...registeredPanes, unregisteredPane]) {
      db.recordLaunch({
        hostId: HOST_ID,
        paneKey: pane.paneKey,
        agentType: 'claude',
        sessionId: pane.sessionId,
        launchGeneration: 'gen-0',
        executionHostId: HOST_ID,
        evidence: 'host_launch'
      })
    }
    for (const pane of registeredPanes) {
      insertRegisteredAgent(pane.paneKey)
    }
    // unregisteredPane deliberately gets no `agents` row — a host_launch pane the sweep never
    // registered (diag-r119-2026-09-08.md (C): "not being swept is by design").

    for (const pane of [...registeredPanes, unregisteredPane]) {
      const admitted = await admitAgentLaunch(
        () => db,
        opts(pane.paneKey, pane.sessionId),
        CALLER,
        ctx()
      )
      expect(admitted.spawnOptions.command).toBe(`claude --resume ${pane.sessionId}`)
    }

    const allAudit = rawDb(db)
      .prepare('SELECT verb, outcome, actor_pane_key, reason_code FROM agent_audit ORDER BY seq')
      .all() as { verb: string; outcome: string; actor_pane_key: string; reason_code: string }[]

    // No contest, ever — every pane resumed only its OWN recorded id.
    expect(allAudit.filter((r) => r.verb === 'launch' && r.outcome === 'contested')).toHaveLength(0)

    for (const pane of registeredPanes) {
      const rowsForPane = allAudit.filter((r) => r.actor_pane_key === pane.paneKey)
      expect(rowsForPane).toHaveLength(1)
      expect(rowsForPane[0].verb).toBe('launch_self_resume')
      expect(rowsForPane[0].outcome).toBe('admitted')
      expect(rowsForPane[0].reason_code).toBe(
        `self_resume_same_pane recorded=${pane.sessionId} reported=${pane.sessionId} holder=${pane.paneKey}`
      )
    }

    // The unregistered pane is admitted too (no registered row to consult at all — the plain
    // v2.1 V1 `reasonCode` audit, unaffected by FIX 1's same-pane/contested split).
    const unregisteredRows = allAudit.filter((r) => r.actor_pane_key === unregisteredPane.paneKey)
    expect(unregisteredRows).toHaveLength(1)
    expect(unregisteredRows[0].verb).toBe('launch_self_resume')
    expect(unregisteredRows[0].outcome).toBe('admitted')
    expect(unregisteredRows[0].reason_code).toBe('caller')

    // No new row was written for any pane — SELF_RESUME never records.
    const rowCounts = rawDb(db)
      .prepare('SELECT COUNT(*) as n FROM agent_launch_sessions')
      .get() as { n: number }
    expect(rowCounts.n).toBe(4) // the 4 seeded rows, unchanged
  })
})
