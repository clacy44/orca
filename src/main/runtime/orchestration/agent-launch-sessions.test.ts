// S10-21a C1 (§7, §2.2); C1a (errata 5(p)-5): the launch-session store. Store only — no caller
// wired.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import {
  deleteLaunchRowsForAgent,
  launchBySessionId,
  newestLaunchForPane,
  recordLaunch,
  recordSelfReportRotation,
  setLaunchAgentId
} from './agent-launch-sessions'
import { deleteLaunchRow, PRUNE_GLOBAL, PRUNE_PER_PANE } from './agent-launch-sessions-retention'
import {
  clearSweepRestoreMark,
  getSweepRestoreMark,
  setSweepRestoreMark
} from './agent-sweep-restore-marks'
import { OrchestrationDb } from './db'

describe('S10-21a C1/C1a: agent-launch-sessions store', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    vi.restoreAllMocks()
    orchestrationDb?.close()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function currentSessionRow(
    db: Database.Database,
    hostId: string,
    paneKey: string
  ): { session_id: string } | undefined {
    return db
      .prepare('SELECT session_id FROM current_sessions WHERE host_id = ? AND pane_key = ?')
      .get(hostId, paneKey) as { session_id: string } | undefined
  }

  it('recordLaunch writes agent_launch_sessions and current_sessions atomically', () => {
    const db = rawDb()
    const result = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.row.session_id).toBe('sess-a')
    expect(result.row.previous_session_id).toBeNull()
    expect(result.row.agent_id).toBeNull()
    expect(result.row.evidence).toBe('host_launch')

    expect(currentSessionRow(db, 'local', 'tab1:leaf-a')?.session_id).toBe('sess-a')
  })

  it('T41: two launches into one pane in one generation both succeed and the newer is current', () => {
    const db = rawDb()
    const first = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a1',
      launchGeneration: 'gen-same',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    const second = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a2',
      launchGeneration: 'gen-same',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    // [SCENARIO_CORRECTION] Under the dropped UNIQUE(host_id, pane_key, launch_generation), the
    // second call threw a raw ERR_SQLITE_ERROR (no store-level refusal existed for it). C1a
    // drops that constraint (errata 5(p)-5 item 1): both calls now succeed.
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)

    const rows = db
      .prepare(
        'SELECT session_id FROM agent_launch_sessions WHERE host_id = ? AND pane_key = ? ORDER BY seq ASC'
      )
      .all('local', 'tab1:leaf-a') as { session_id: string }[]
    expect(rows.map((r) => r.session_id)).toEqual(['sess-a1', 'sess-a2'])
    expect(newestLaunchForPane(db, 'local', 'tab1:leaf-a')?.session_id).toBe('sess-a2')
    expect(currentSessionRow(db, 'local', 'tab1:leaf-a')?.session_id).toBe('sess-a2')
  })

  it("a rotation whose successor id is another pane's current session refuses foreign_session_id with no partial write", () => {
    const db = rawDb()
    recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-b',
      agentType: 'claude',
      sessionId: 'sess-b',
      launchGeneration: 'gen-2',
      executionHostId: 'local',
      evidence: 'host_launch'
    })

    // pane b's process reports rotating to 'sess-a' — already pane a's current session.
    const rotation = recordSelfReportRotation(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-b',
      previousSessionId: 'sess-b',
      sessionId: 'sess-a',
      launchGeneration: 'gen-2',
      executionHostId: 'local'
    })
    expect(rotation).toEqual({ ok: false, reason: 'foreign_session_id' })

    // both tables unchanged
    expect(currentSessionRow(db, 'local', 'tab1:leaf-a')?.session_id).toBe('sess-a')
    expect(currentSessionRow(db, 'local', 'tab1:leaf-b')?.session_id).toBe('sess-b')
    const paneBRow = launchBySessionId(db, 'sess-b')
    expect(paneBRow).toBeDefined()
    expect(paneBRow?.previous_session_id).toBeNull()
    expect(paneBRow?.evidence).toBe('host_launch')
    expect(launchBySessionId(db, 'sess-a')?.pane_key).toBe('tab1:leaf-a')
  })

  it('a qualifying rotation updates the row in place, recording previous_session_id and the new evidence', () => {
    const db = rawDb()
    recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })

    const rotation = recordSelfReportRotation(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      previousSessionId: 'sess-a',
      sessionId: 'sess-a2',
      launchGeneration: 'gen-1',
      executionHostId: 'local'
    })
    expect(rotation.ok).toBe(true)
    if (!rotation.ok) {
      return
    }
    expect(rotation.row.session_id).toBe('sess-a2')
    expect(rotation.row.previous_session_id).toBe('sess-a')
    expect(rotation.row.evidence).toBe('self_report_rotation')

    expect(currentSessionRow(db, 'local', 'tab1:leaf-a')?.session_id).toBe('sess-a2')
    // no new row: the original session id no longer resolves via agent_launch_sessions.
    expect(launchBySessionId(db, 'sess-a')).toBeUndefined()
    const all = db.prepare('SELECT COUNT(*) AS c FROM agent_launch_sessions').get() as {
      c: number
    }
    expect(all.c).toBe(1)
  })

  it('rotation targets the newest row by seq when two rows exist for the pane, ignoring a stale launch_generation', () => {
    const db = rawDb()
    const first = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a1',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    const second = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a2',
      launchGeneration: 'gen-2',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    expect(first.ok && second.ok).toBe(true)

    // [errata 5(p)-5 item 2] launchGeneration in params names the FIRST row's generation
    // ('gen-1'), which is now stale — the store must still target the pane's newest row
    // (seq of 'sess-a2'), not refuse or match by generation.
    const rotation = recordSelfReportRotation(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      previousSessionId: 'sess-a2',
      sessionId: 'sess-a3',
      launchGeneration: 'gen-1',
      executionHostId: 'local'
    })
    expect(rotation.ok).toBe(true)
    if (!rotation.ok) {
      return
    }
    expect(rotation.row.session_id).toBe('sess-a3')
    if (!first.ok || !second.ok) {
      return
    }
    expect(rotation.row.seq).toBe(second.row.seq)

    // the older row (sess-a1) is untouched.
    const untouched = launchBySessionId(db, 'sess-a1')
    expect(untouched?.evidence).toBe('host_launch')
    expect(untouched?.seq).toBe(first.row.seq)
    expect(currentSessionRow(db, 'local', 'tab1:leaf-a')?.session_id).toBe('sess-a3')
  })

  it('a rotation naming a (host,pane,generation) with no existing row refuses no_matching_launch_row', () => {
    const db = rawDb()
    const rotation = recordSelfReportRotation(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-ghost',
      previousSessionId: 'sess-x',
      sessionId: 'sess-y',
      launchGeneration: 'gen-ghost',
      executionHostId: 'local'
    })
    expect(rotation).toEqual({ ok: false, reason: 'no_matching_launch_row' })
    expect(currentSessionRow(db, 'local', 'tab1:leaf-ghost')).toBeUndefined()
  })

  it('supersedePaneKey moves a session id from P_pred to P_new in one transaction', () => {
    const db = rawDb()
    const predLaunch = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-pred',
      agentType: 'claude',
      sessionId: 'sess-restore',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    expect(predLaunch.ok).toBe(true)
    expect(currentSessionRow(db, 'local', 'tab1:leaf-pred')?.session_id).toBe('sess-restore')

    const restore = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-new',
      agentType: 'claude',
      sessionId: 'sess-restore',
      launchGeneration: 'gen-2',
      executionHostId: 'local',
      evidence: 'host_launch',
      supersedePaneKey: 'tab1:leaf-pred'
    })
    expect(restore.ok).toBe(true)
    if (!restore.ok) {
      return
    }
    expect(restore.row.session_id).toBe('sess-restore')

    // P_pred's current_sessions row is gone; P_new's is present.
    expect(currentSessionRow(db, 'local', 'tab1:leaf-pred')).toBeUndefined()
    expect(currentSessionRow(db, 'local', 'tab1:leaf-new')?.session_id).toBe('sess-restore')
  })

  it('[JUDGMENT CALL, see RETURN block] a same-pane current_sessions UNIQUE violation is classified as an idempotent success', () => {
    const db = rawDb()
    const first = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-x',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }

    // Empirically, upsertCurrentSession's `ON CONFLICT(host_id, pane_key) DO UPDATE` resolves a
    // same-pane restatement of the SAME session_id without ever raising — the target-matching
    // conflict is handled by the DO UPDATE before any OTHER unique index is checked against the
    // very row being updated. So the "conflicting row belongs to the same pane" branch (errata
    // 5(p)-5 item 4) cannot be reached through any sequence of ordinary recordLaunch calls; it
    // is fabricated here via a spy to exercise the classification logic itself.
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = prepare(sql)
      if (sql.includes('INSERT INTO current_sessions')) {
        stmt.run = (() => {
          const err = new Error(
            'UNIQUE constraint failed: current_sessions.host_id, current_sessions.session_id'
          ) as Error & { code?: string }
          err.code = 'ERR_SQLITE_ERROR'
          throw err
        }) as typeof stmt.run
      }
      return stmt
    })

    const retry = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-x',
      launchGeneration: 'gen-2',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    vi.restoreAllMocks()

    // [D-R104 F-12, forced deviation — pre-existing fixture] `recordLaunch`'s idempotent branch
    // now returns `restated: true` so its caller (admission) never closes confirm/compensate
    // over a row it did not insert.
    expect(retry).toEqual({ ok: true, row: first.row, restated: true })
    // no duplicate row: the retry's own insert was rolled back with the rest of its transaction.
    const count = db.prepare('SELECT COUNT(*) AS c FROM agent_launch_sessions').get() as {
      c: number
    }
    expect(count.c).toBe(1)
  })

  it('prune bounds: a 4th row for one pane evicts the lowest seq for that pane only', () => {
    const db = rawDb()
    for (let i = 1; i <= 4; i++) {
      recordLaunch(db, {
        hostId: 'local',
        paneKey: 'tab1:leaf-a',
        agentType: 'claude',
        sessionId: `sess-${i}`,
        launchGeneration: `gen-${i}`,
        executionHostId: 'local',
        evidence: 'host_launch'
      })
    }
    const rows = db
      .prepare('SELECT session_id FROM agent_launch_sessions WHERE pane_key = ? ORDER BY seq ASC')
      .all('tab1:leaf-a') as { session_id: string }[]
    expect(rows.map((r) => r.session_id)).toEqual(['sess-2', 'sess-3', 'sess-4'])
    expect(PRUNE_PER_PANE).toBe(3)
  })

  it("[D-D4 V3, SCENARIO_CORRECTION] the global prune never deletes a row that is its pane's newest — the per-host count may exceed 512", () => {
    const db = rawDb()
    for (let i = 1; i <= 513; i++) {
      recordLaunch(db, {
        hostId: 'local',
        paneKey: `tab1:leaf-${i}`,
        agentType: 'claude',
        sessionId: `sess-${i}`,
        launchGeneration: `gen-${i}`,
        executionHostId: 'local',
        evidence: 'host_launch'
      })
    }
    // [SCENARIO_CORRECTION] The old global prune had no "never delete a pane's newest" fence,
    // so a 513th row (in ANY pane) evicted the globally-oldest row and the table settled at
    // exactly 512 (`expect(total.c).toBe(512)`). Under [D-D4 V3, binding], every one of these
    // 513 rows IS its own pane's newest (one launch per distinct pane) — none are eligible for
    // eviction, so the table stays at 513, above the 512 cap, exactly as the D-D4 comment in
    // pruneGlobalRows documents.
    const total = db.prepare('SELECT COUNT(*) AS c FROM agent_launch_sessions').get() as {
      c: number
    }
    expect(total.c).toBe(513)
    expect(launchBySessionId(db, 'sess-1')).toBeDefined()
    expect(launchBySessionId(db, 'sess-513')).toBeDefined()
  })

  it('the global prune evicts oldest non-newest rows once the per-host count exceeds 512, keeping every newest row', () => {
    const db = rawDb()
    const PANES = 171 // 171 * 3 = 513 rows total, each pane at its own <=3 cap (never pruned per-pane)
    for (let p = 1; p <= PANES; p++) {
      for (let k = 1; k <= 3; k++) {
        recordLaunch(db, {
          hostId: 'local',
          paneKey: `tab1:leaf-${p}`,
          agentType: 'claude',
          sessionId: `sess-${p}-${k}`,
          launchGeneration: `gen-${p}-${k}`,
          executionHostId: 'local',
          evidence: 'host_launch'
        })
      }
    }
    const total = db.prepare('SELECT COUNT(*) AS c FROM agent_launch_sessions').get() as {
      c: number
    }
    expect(total.c).toBeLessThanOrEqual(PRUNE_GLOBAL)
    // every pane's newest (3rd) launch survives regardless.
    expect(newestLaunchForPane(db, 'local', 'tab1:leaf-1')?.session_id).toBe('sess-1-3')
    expect(newestLaunchForPane(db, 'local', 'tab1:leaf-171')?.session_id).toBe('sess-171-3')
    // pane 1's oldest (non-newest) row was evicted by the global prune (globally oldest surplus).
    expect(launchBySessionId(db, 'sess-1-1')).toBeUndefined()
  })

  it("prune runs outside recordLaunch's txn — a prune that throws does not undo the recorded launch", () => {
    const db = rawDb()
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = prepare(sql)
      if (sql.includes('WHERE host_id = ? AND pane_key = ? AND seq NOT IN')) {
        stmt.run = (() => {
          throw new Error('injected prune failure')
        }) as typeof stmt.run
      }
      return stmt
    })

    expect(() =>
      recordLaunch(db, {
        hostId: 'local',
        paneKey: 'tab1:leaf-a',
        agentType: 'claude',
        sessionId: 'sess-a',
        launchGeneration: 'gen-1',
        executionHostId: 'local',
        evidence: 'host_launch'
      })
    ).toThrow(/injected prune failure/)
    vi.restoreAllMocks()

    // the launch itself is still recorded — the prune failure did not roll it back.
    expect(launchBySessionId(db, 'sess-a')).toBeDefined()
    expect(currentSessionRow(db, 'local', 'tab1:leaf-a')?.session_id).toBe('sess-a')
  })

  it("prune is host-scoped — another host's rows are untouched", () => {
    const db = rawDb()
    for (let i = 1; i <= 4; i++) {
      recordLaunch(db, {
        hostId: 'host-a',
        paneKey: 'tab1:leaf-a',
        agentType: 'claude',
        sessionId: `a-sess-${i}`,
        launchGeneration: `gen-${i}`,
        executionHostId: 'host-a',
        evidence: 'host_launch'
      })
      recordLaunch(db, {
        hostId: 'host-b',
        paneKey: 'tab1:leaf-a',
        agentType: 'claude',
        sessionId: `b-sess-${i}`,
        launchGeneration: `gen-${i}`,
        executionHostId: 'host-b',
        evidence: 'host_launch'
      })
    }
    // host-a's pane was pruned to <=3 by its own recordLaunch calls; host-b's calls (same pane
    // key, different host) must not have evicted any of host-a's rows beyond its own cap, and
    // vice versa.
    const hostARows = db
      .prepare('SELECT session_id FROM agent_launch_sessions WHERE host_id = ? ORDER BY seq ASC')
      .all('host-a') as { session_id: string }[]
    const hostBRows = db
      .prepare('SELECT session_id FROM agent_launch_sessions WHERE host_id = ? ORDER BY seq ASC')
      .all('host-b') as { session_id: string }[]
    expect(hostARows.map((r) => r.session_id)).toEqual(['a-sess-2', 'a-sess-3', 'a-sess-4'])
    expect(hostBRows.map((r) => r.session_id)).toEqual(['b-sess-2', 'b-sess-3', 'b-sess-4'])
  })

  it('T33 idempotence half: prune never deletes a current_sessions row', () => {
    const db = rawDb()
    for (let i = 1; i <= 4; i++) {
      recordLaunch(db, {
        hostId: 'local',
        paneKey: 'tab1:leaf-a',
        agentType: 'claude',
        sessionId: `sess-${i}`,
        launchGeneration: `gen-${i}`,
        executionHostId: 'local',
        evidence: 'host_launch'
      })
    }
    // the pane's current_sessions row survives every prune, always naming the true newest.
    expect(currentSessionRow(db, 'local', 'tab1:leaf-a')?.session_id).toBe('sess-4')
    const currentCount = db.prepare('SELECT COUNT(*) AS c FROM current_sessions').get() as {
      c: number
    }
    expect(currentCount.c).toBe(1)
  })

  it('newest-by-seq beats recorded_at ties: the higher-seq row wins even when its recorded_at sorts earlier', () => {
    const db = rawDb()
    recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-first',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-second',
      launchGeneration: 'gen-2',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    // Force a tie/inversion on recorded_at (both rows land in the same 1-second window, and the
    // later-seq row is even given the EARLIER recorded_at) — a recorded_at-ordered read would
    // pick 'sess-first'; the seq-ordered read must still pick 'sess-second'.
    db.prepare(
      `UPDATE agent_launch_sessions SET recorded_at = '2020-01-01 00:00:00' WHERE session_id = 'sess-first'`
    ).run()
    db.prepare(
      `UPDATE agent_launch_sessions SET recorded_at = '2019-01-01 00:00:00' WHERE session_id = 'sess-second'`
    ).run()

    const newest = newestLaunchForPane(db, 'local', 'tab1:leaf-a')
    expect(newest?.session_id).toBe('sess-second')
  })

  it('setLaunchAgentId by seq and by pane both target the intended row', () => {
    const db = rawDb()
    const launch = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    expect(launch.ok).toBe(true)
    if (!launch.ok) {
      return
    }
    setLaunchAgentId(db, { seq: launch.row.seq }, 'agt_1')
    expect(launchBySessionId(db, 'sess-a')?.agent_id).toBe('agt_1')

    setLaunchAgentId(db, { hostId: 'local', paneKey: 'tab1:leaf-a' }, 'agt_2')
    expect(launchBySessionId(db, 'sess-a')?.agent_id).toBe('agt_2')
  })

  it("deleteLaunchRowsForAgent removes only that agent's rows", () => {
    const db = rawDb()
    const a = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    const b = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-b',
      agentType: 'claude',
      sessionId: 'sess-b',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) {
      return
    }
    setLaunchAgentId(db, { seq: a.row.seq }, 'agt_a')
    setLaunchAgentId(db, { seq: b.row.seq }, 'agt_b')

    const deleted = deleteLaunchRowsForAgent(db, 'agt_a')
    expect(deleted).toBe(1)
    expect(launchBySessionId(db, 'sess-a')).toBeUndefined()
    expect(launchBySessionId(db, 'sess-b')).toBeDefined()
  })

  it('deleteLaunchRow repoints current_sessions to the next-newest row', () => {
    const db = rawDb()
    const first = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a1',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    const second = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a2',
      launchGeneration: 'gen-2',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) {
      return
    }
    expect(currentSessionRow(db, 'local', 'tab1:leaf-a')?.session_id).toBe('sess-a2')

    deleteLaunchRow(db, second.row.seq)
    expect(currentSessionRow(db, 'local', 'tab1:leaf-a')?.session_id).toBe('sess-a1')
    expect(launchBySessionId(db, 'sess-a2')).toBeUndefined()
  })

  it('deleteLaunchRow deletes the current_sessions row when no launch row remains', () => {
    const db = rawDb()
    const only = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    expect(only.ok).toBe(true)
    if (!only.ok) {
      return
    }
    deleteLaunchRow(db, only.row.seq)
    expect(currentSessionRow(db, 'local', 'tab1:leaf-a')).toBeUndefined()
  })

  it('sweep restore marks: set is idempotent, get reflects it, clear removes it', () => {
    const db = rawDb()
    expect(getSweepRestoreMark(db, 'local', 'tab1:leaf-a')).toBe(false)
    setSweepRestoreMark(db, 'local', 'tab1:leaf-a')
    expect(getSweepRestoreMark(db, 'local', 'tab1:leaf-a')).toBe(true)
    setSweepRestoreMark(db, 'local', 'tab1:leaf-a') // idempotent, no error
    expect(getSweepRestoreMark(db, 'local', 'tab1:leaf-a')).toBe(true)
    clearSweepRestoreMark(db, 'local', 'tab1:leaf-a')
    expect(getSweepRestoreMark(db, 'local', 'tab1:leaf-a')).toBe(false)
  })
})
