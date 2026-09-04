// S10-21a C6/C6a (design v3.2 §2.3, §2.6, §1.6; D-R107; Ruling 34 Addendum 18): T23, T30, T31,
// T33 as §6.1 states them, the unconditional audit, source-'fork'-only conjunct 4, suffix
// resolution, the unrecorded_launch honesty floor, and the current_sessions read-only fence.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { evaluateLiveHookReportMismatch } from './agent-lineage-mismatch'
import { newestLaunchForPane, recordLaunch } from './agent-launch-sessions'
import { OrchestrationDb } from './db'

const HOST_ID = 'local'
const PANE = 'tab1:leaf-a'

describe('S10-21a C6a: evaluateLiveHookReportMismatch', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    vi.restoreAllMocks()
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
      anchorCorroborated: true,
      sessionStartSource: 'fork'
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
      anchorCorroborated: true,
      sessionStartSource: 'fork'
    })
    expect(result).toEqual({ kind: 'no_row' })
  })

  it('T30: all four conjuncts hold (source fork) — self-report rotation accepted, no alarm', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      reportedPreviousSessionId: 'sess-a',
      anchorCorroborated: true,
      sessionStartSource: 'fork'
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

  it("D-R107 fix item 8: source 'startup' with a matching previous id does NOT satisfy conjunct 4 — alarm, not a rotation", () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      reportedPreviousSessionId: 'sess-a',
      anchorCorroborated: true,
      sessionStartSource: 'startup'
    })
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
  })

  it('T31: anchor not corroborated — foreign-id mismatch, alarm, row unchanged', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      reportedPreviousSessionId: 'sess-a',
      anchorCorroborated: false,
      sessionStartSource: 'fork'
    })
    expect(result).toEqual({ kind: 'foreign_mismatch' })
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
      anchorCorroborated: true,
      sessionStartSource: 'fork'
    })
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
  })

  it('conjunct 4 missing (no SessionStart observed) — alarm, row unchanged', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      reportedPreviousSessionId: 'sess-a',
      anchorCorroborated: true,
      sessionStartSource: undefined
    })
    expect(result).toEqual({ kind: 'foreign_mismatch' })
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
      anchorCorroborated: true,
      sessionStartSource: 'fork'
    })
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
    // The victim pane's own row/current_sessions entry is untouched by the refused collision.
    expect(newestLaunchForPane(db, HOST_ID, 'tab2:leaf-b')?.session_id).toBe('sess-victim')
    expect(currentSessionRow(db, 'tab2:leaf-b')?.session_id).toBe('sess-victim')
  })

  it('D-R107 MEDIUM-1/fix item 2: a pane that moved tabs (same suffix, new tabId prefix) is still resolved — no false no_row', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a', 'tab-OLD:leaf-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: 'tab-NEW:leaf-a',
      reportedSessionId: 'sess-a',
      reportedPreviousSessionId: null,
      anchorCorroborated: true,
      sessionStartSource: 'fork'
    })
    expect(result).toEqual({ kind: 'match' })
  })

  it("Ruling 34 Addendum 18: the audit is UNCONDITIONAL — two mismatches within an hour produce TWO audit rows (not clamped; the notice is the caller's own, separately clamped, job)", () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const first = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      reportedPreviousSessionId: null,
      anchorCorroborated: false,
      sessionStartSource: undefined
    })
    const second = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-c',
      reportedPreviousSessionId: null,
      anchorCorroborated: false,
      sessionStartSource: undefined
    })
    expect(first).toEqual({ kind: 'foreign_mismatch' })
    expect(second).toEqual({ kind: 'foreign_mismatch' })
    expect(auditRows(db, PANE)).toHaveLength(2)
  })

  it('Ruling 34 Addendum 18(iii): a pane whose newest admission outcome this generation was UNRECORDED classifies unrecorded_launch, not a contest', () => {
    const db = rawDb()
    const row = seedLaunch(db, 'sess-a')
    // A later UNRECORDED admission audit for this same pane (e.g. a plain shell re-spawned into
    // it) — newer than the launch row's own recorded_at.
    db.prepare(
      `INSERT INTO agent_audit (agent_id, actor_pane_key, actor_host_id, verb, outcome, reason_code, at)
         VALUES (NULL, ?, ?, 'launch_unrecorded', 'admitted', 'pane_key_owned', datetime('now', '+1 second'))`
    ).run(PANE, HOST_ID)
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      reportedPreviousSessionId: null,
      anchorCorroborated: false,
      sessionStartSource: undefined
    })
    expect(result).toEqual({ kind: 'unrecorded_launch', reason: 'pane_key_owned' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
    const rows = db
      .prepare(
        `SELECT outcome, reason_code FROM agent_audit
           WHERE actor_pane_key = ? AND verb = 'session_identity_mismatch'`
      )
      .all(PANE) as { outcome: string; reason_code: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('unrecorded_launch')
    expect(rows[0].reason_code).toContain('pane_key_owned')
    void row
  })

  it('an UNRECORDED audit OLDER than the launch row does not suppress the contest (the admission spoke, then the launch happened)', () => {
    const db = rawDb()
    db.prepare(
      `INSERT INTO agent_audit (agent_id, actor_pane_key, actor_host_id, verb, outcome, reason_code, at)
         VALUES (NULL, ?, ?, 'launch_unrecorded', 'admitted', 'stale_reason', datetime('now', '-1 hour'))`
    ).run(PANE, HOST_ID)
    seedLaunch(db, 'sess-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      reportedPreviousSessionId: null,
      anchorCorroborated: false,
      sessionStartSource: undefined
    })
    expect(result).toEqual({ kind: 'foreign_mismatch' })
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
      anchorCorroborated: true,
      sessionStartSource: 'fork'
    })
    // A refused (non-rotation) mismatch leaves current_sessions exactly as it was — reads only.
    expect(currentSessionRow(db, PANE)).toEqual(before)
  })
})
