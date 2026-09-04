// S10-21a C1 (§7, §2.2): the launch-session store. Store only — no caller wired.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import {
  clearSweepRestoreMark,
  deleteLaunchRowsForAgent,
  getSweepRestoreMark,
  launchBySessionId,
  newestLaunchForPane,
  recordLaunch,
  recordSelfReportRotation,
  setLaunchAgentId,
  setSweepRestoreMark
} from './agent-launch-sessions'
import { OrchestrationDb } from './db'

describe('S10-21a C1: agent-launch-sessions store', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
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
  })

  it('prune bounds: the 513th global row evicts the globally lowest seq', () => {
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
    const total = db.prepare('SELECT COUNT(*) AS c FROM agent_launch_sessions').get() as {
      c: number
    }
    expect(total.c).toBe(512)
    expect(launchBySessionId(db, 'sess-1')).toBeUndefined()
    expect(launchBySessionId(db, 'sess-513')).toBeDefined()
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
