// S10-21a C6/C6a/C6b (design v3.2 §2.3, §2.6, §1.6; D-R107; D-R108; Ruling 34 Addendum 18/19):
// T23, T30, T31, T33 as §6.1 states them, the unconditional audit, source-'fork'-only conjunct
// 4, suffix resolution, the generation-bound/any-verb unrecorded_launch honesty floor, and the
// current_sessions read-only fence.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { evaluateLiveHookReportMismatch } from './agent-lineage-mismatch'
import { newestLaunchForPane, recordLaunch } from './agent-launch-sessions'
import { OrchestrationDb } from './db'

const HOST_ID = 'local'
const PANE = 'tab1:leaf-a'
const GEN = 'gen-1'

describe('S10-21a C6b: evaluateLiveHookReportMismatch', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    vi.restoreAllMocks()
    orchestrationDb?.close()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function seedLaunch(
    db: Database.Database,
    sessionId: string,
    paneKey = PANE,
    launchGeneration = GEN
  ) {
    const result = recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId,
      launchGeneration,
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    if (!result.ok) {
      throw new Error('seed failed')
    }
    return result.row
  }

  function writeAdmissionAudit(
    db: Database.Database,
    verb: string,
    reasonCode: string | null,
    paneKey = PANE,
    atOffset = '+1 second'
  ) {
    db.prepare(
      `INSERT INTO agent_audit (agent_id, actor_pane_key, actor_host_id, verb, outcome, reason_code, at)
         VALUES (NULL, ?, ?, ?, 'admitted', ?, datetime('now', ?))`
    ).run(paneKey, HOST_ID, verb, reasonCode, atOffset)
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
      anchorCorroborated: true,
      sessionStartSource: 'fork',
      launchGeneration: GEN
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
      anchorCorroborated: true,
      sessionStartSource: 'fork',
      launchGeneration: GEN
    })
    expect(result).toEqual({ kind: 'no_row' })
  })

  it('T30: conjuncts 1+4 hold (source fork) — self-report rotation accepted, no alarm (conjunct 2 is tautological, errata 5(ab))', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: true,
      sessionStartSource: 'fork',
      launchGeneration: GEN
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

  it("D-R107 fix item 8: source 'startup' does NOT satisfy conjunct 4 — alarm, not a rotation", () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: true,
      sessionStartSource: 'startup',
      launchGeneration: GEN
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
      anchorCorroborated: false,
      sessionStartSource: 'fork',
      launchGeneration: GEN
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

  it('conjunct 4 missing (no SessionStart observed) — alarm, row unchanged', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: true,
      sessionStartSource: undefined,
      launchGeneration: GEN
    })
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
  })

  it("T33: conjuncts 1+4 hold but the successor collides with another pane's newest id — alarm, row unchanged", () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a', PANE)
    seedLaunch(db, 'sess-victim', 'tab2:leaf-b')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-victim',
      anchorCorroborated: true,
      sessionStartSource: 'fork',
      launchGeneration: GEN
    })
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
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
      anchorCorroborated: true,
      sessionStartSource: 'fork',
      launchGeneration: GEN
    })
    expect(result).toEqual({ kind: 'match' })
  })

  it('Ruling 34 Addendum 18: the audit is UNCONDITIONAL — two mismatches produce TWO audit rows', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const first = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    })
    const second = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-c',
      anchorCorroborated: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    })
    expect(first).toEqual({ kind: 'foreign_mismatch' })
    expect(second).toEqual({ kind: 'foreign_mismatch' })
    expect(auditRows(db, PANE)).toHaveLength(2)
  })

  // ---- D-R108 R1: the unrecorded_launch downgrade ----

  it('D-R108 R1: a pane whose newest admission audit (any verb) this generation IS unrecorded classifies unrecorded_launch', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    writeAdmissionAudit(db, 'launch_unrecorded', 'pane_key_owned')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    })
    expect(result).toEqual({ kind: 'unrecorded_launch', reason: 'pane_key_owned' })
    const rows = db
      .prepare(
        `SELECT outcome, reason_code FROM agent_audit
           WHERE actor_pane_key = ? AND verb = 'session_identity_mismatch'`
      )
      .all(PANE) as { outcome: string; reason_code: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('unrecorded_launch')
    expect(rows[0].reason_code).toContain('pane_key_owned')
  })

  it('D-R108 R1(a): after an UNRECORDED admission, a LATER admission audit of a DIFFERENT verb (not unrecorded) restores normal classification', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    writeAdmissionAudit(db, 'launch_unrecorded', 'pane_key_owned', PANE, '+1 second')
    writeAdmissionAudit(db, 'launch_refused', 'some_refusal', PANE, '+2 seconds')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    })
    expect(result).toEqual({ kind: 'foreign_mismatch' })
  })

  it('D-R108 R1(a)/(test list): after an UNRECORDED admission, a LATER HOST_MINTED launch (no audit row, but a fresher recorded row) restores normal classification', () => {
    const db = rawDb()
    writeAdmissionAudit(db, 'launch_unrecorded', 'pane_key_owned', PANE, '-1 second')
    seedLaunch(db, 'sess-a') // the "later HOST_MINTED launch" — recorded_at is now
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    })
    expect(result).toEqual({ kind: 'foreign_mismatch' })
  })

  it('D-R108 R1(b): a PRIOR-GENERATION unrecorded audit does not downgrade — the launch row is from a different generation', () => {
    const db = rawDb()
    // The row's own generation differs from what the live pane now reports under.
    seedLaunch(db, 'sess-a', PANE, 'gen-0')
    writeAdmissionAudit(db, 'launch_unrecorded', 'pane_key_owned', PANE, '+1 second')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      sessionStartSource: undefined,
      launchGeneration: 'gen-1' // the CURRENT generation, distinct from the row's 'gen-0'
    })
    expect(result).toEqual({ kind: 'foreign_mismatch' })
  })

  it('D-R108 (test list): a foreign mismatch after a pane_key_owned UNRECORDED admission from a different caller is still contested when a recorded launch is newer', () => {
    const db = rawDb()
    writeAdmissionAudit(db, 'launch_unrecorded', 'pane_key_owned', PANE, '-5 seconds')
    seedLaunch(db, 'sess-a') // the recorded launch, newer than the unrecorded admission above
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    })
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    const rows = db
      .prepare(
        `SELECT outcome FROM agent_audit WHERE actor_pane_key = ? AND verb = 'session_identity_mismatch'`
      )
      .all(PANE) as { outcome: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('contested')
  })

  it('D-R108 R1(c): the admission audit is resolved by pane SUFFIX, same rule as the launch row', () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a', 'tab-OLD:leaf-a')
    writeAdmissionAudit(db, 'launch_unrecorded', 'pane_key_owned', 'tab-OLD:leaf-a', '+1 second')
    const result = evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: 'tab-NEW:leaf-a',
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    })
    expect(result).toEqual({ kind: 'unrecorded_launch', reason: 'pane_key_owned' })
  })

  it("fence: no path here writes current_sessions directly — only recordSelfReportRotation's own accepted-rotation upsert does", () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const before = currentSessionRow(db, PANE)
    evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    })
    expect(currentSessionRow(db, PANE)).toEqual(before)
  })
})
