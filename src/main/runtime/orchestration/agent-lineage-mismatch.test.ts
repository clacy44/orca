// S10-21a C6 (design v3.2 §2.3, §2.6, §1.6): T23, T30, T31, T33 as §6.1 states them, the hourly
// clamp, and the current_sessions read-only fence.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { evaluateLiveHookReportMismatch } from './agent-lineage-mismatch'
import { newestLaunchForPane, recordLaunch } from './agent-launch-sessions'
import { OrchestrationDb } from './db'

const HOST_ID = 'local'
const PANE = 'tab1:leaf-a'

describe('S10-21a C6: evaluateLiveHookReportMismatch', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function seedLaunch(db: Database.Database, sessionId: string, paneKey = PANE) {
    const result = recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId,
      launchGeneration: 'gen-1',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    if (!result.ok) {
      throw new Error('seed failed')
    }
    return result.row
  }

  function auditRows(db: Database.Database, paneKey: string) {
    return db
      .prepare(
        `SELECT verb, outcome, reason_code FROM agent_audit
           WHERE actor_pane_key = ? AND verb = 'session_identity_mismatch'`
      )
      .all(paneKey) as { verb: string; outcome: string; reason_code: string | null }[]
  }

  function currentSessionRow(db: Database.Database, paneKey: string) {
    return db
      .prepare('SELECT session_id FROM current_sessions WHERE host_id = ? AND pane_key = ?')
      .get(HOST_ID, paneKey) as { session_id: string } | undefined
  }

  it('an agreeing report is a match — no audit, no row change', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-a',
      reportedPreviousSessionId: null,
      anchorVerified: true,
      sessionStartObservedThisGeneration: true
    })
    expect(result).toEqual({ kind: 'match' })
    expect(auditRows(db, PANE)).toHaveLength(0)
  })

  it('a pane with no launch row reports no_row — nothing to compare against', () => {
    const db = rawDb()
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-a',
      reportedPreviousSessionId: null,
      anchorVerified: true,
      sessionStartObservedThisGeneration: true
    })
    expect(result).toEqual({ kind: 'no_row' })
  })

  it('T30: all four conjuncts hold — self-report rotation accepted, no alarm', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      reportedPreviousSessionId: 'sess-a',
      anchorVerified: true,
      sessionStartObservedThisGeneration: true
    })
    expect(result.kind).toBe('rotated')
    if (result.kind === 'rotated') {
      expect(result.row.session_id).toBe('sess-b')
      expect(result.row.previous_session_id).toBe('sess-a')
      expect(result.row.evidence).toBe('self_report_rotation')
    }
    expect(auditRows(db, PANE)).toHaveLength(0)
    expect(currentSessionRow(db, PANE)?.session_id).toBe('sess-b')
  })

  it('T31: anchor not verified — foreign-id mismatch, alarm, row unchanged', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      reportedPreviousSessionId: 'sess-a',
      anchorVerified: false,
      sessionStartObservedThisGeneration: true
    })
    expect(result).toEqual({ kind: 'foreign_mismatch', auditWritten: true })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
    const rows = auditRows(db, PANE)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      outcome: 'contested',
      reason_code: 'recorded=sess-a reported=sess-b'
    })
  })

  it("T31: reported previous id does not chain to the pane's own last-recorded id — alarm, row unchanged", () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      reportedPreviousSessionId: 'some-other-panes-id',
      anchorVerified: true,
      sessionStartObservedThisGeneration: true
    })
    expect(result).toEqual({ kind: 'foreign_mismatch', auditWritten: true })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
  })

  it('conjunct 4 missing (no SessionStart observed this generation) — alarm, row unchanged', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      reportedPreviousSessionId: 'sess-a',
      anchorVerified: true,
      sessionStartObservedThisGeneration: false
    })
    expect(result).toEqual({ kind: 'foreign_mismatch', auditWritten: true })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
  })

  it("T33: conjuncts 1-2-4 hold but the successor collides with another pane's newest id — alarm, row unchanged", () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a', PANE)
    seedLaunch(db, 'sess-victim', 'tab2:leaf-b')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-victim',
      reportedPreviousSessionId: 'sess-a',
      anchorVerified: true,
      sessionStartObservedThisGeneration: true
    })
    expect(result).toEqual({ kind: 'foreign_mismatch', auditWritten: true })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
    // The victim pane's own row/current_sessions entry is untouched by the refused collision.
    expect(newestLaunchForPane(db, HOST_ID, 'tab2:leaf-b')?.session_id).toBe('sess-victim')
    expect(currentSessionRow(db, 'tab2:leaf-b')?.session_id).toBe('sess-victim')
  })

  it('the hourly clamp: two mismatches within an hour produce one audit row', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const first = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      reportedPreviousSessionId: null,
      anchorVerified: false,
      sessionStartObservedThisGeneration: false
    })
    const second = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-c',
      reportedPreviousSessionId: null,
      anchorVerified: false,
      sessionStartObservedThisGeneration: false
    })
    expect(first).toEqual({ kind: 'foreign_mismatch', auditWritten: true })
    expect(second).toEqual({ kind: 'foreign_mismatch', auditWritten: false })
    expect(auditRows(db, PANE)).toHaveLength(1)
  })

  it("fence: no path here writes current_sessions directly — only recordSelfReportRotation's own accepted-rotation upsert does", () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const before = currentSessionRow(db, PANE)
    evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      reportedPreviousSessionId: 'not-sess-a',
      anchorVerified: true,
      sessionStartObservedThisGeneration: true
    })
    // A refused (non-rotation) mismatch leaves current_sessions exactly as it was — reads only.
    expect(currentSessionRow(db, PANE)).toEqual(before)
  })
})
