// S10-21a C6/C6a/C6b (design v3.2 §2.3, §2.6, §1.6; D-R107; D-R108; Ruling 34 Addendum 18/19):
// T23, T31, T33 as §6.1 states them, the unconditional audit, suffix resolution, the
// generation-bound/any-verb unrecorded_launch honesty floor, and the current_sessions
// read-only fence.
// [S10-21c B4, design §2 S3] Two SCENARIO CORRECTIONS live here, each flagged at its own test:
// conjunct 1 is now `anchorHostVerified` (strictly stronger) and conjunct 4
// (`sessionStartSource === 'fork'`) is DROPPED. The reconciliation/bootstrap capability itself
// is fenced in agent-lineage-live-report.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import {
  evaluateLiveHookReportMismatch,
  type ResolveLiveReportTranscript
} from './agent-lineage-mismatch'
import { newestLaunchForPane, recordLaunch } from './agent-launch-sessions'
import { OrchestrationDb } from './db'

// [S10-21c B4] Conjunct (iii)'s resolver, stubbed real for every case in this file: these
// tests fence conjuncts (i), (ii), (iv) and the contest/unrecorded paths, so the transcript
// must never be the thing that refuses. S3/S5's own three-state coverage lives in
// agent-lineage-live-report.test.ts.
const REAL_TRANSCRIPT: ResolveLiveReportTranscript = async () => ({
  path: '/transcripts/real.jsonl',
  hasTurn: true
})

const HOST_ID = 'local'
const PANE = 'tab1:leaf-a'
const GEN = 'gen-1'

describe('S10-21a C6b: evaluateLiveHookReportMismatch', async () => {
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

  it('an agreeing report is a match — no audit, no row change', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-a',
      anchorCorroborated: true,
      anchorHostVerified: false,
      sessionStartSource: 'fork',
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    expect(result).toEqual({ kind: 'match' })
    expect(auditRows(db, PANE)).toHaveLength(0)
  })

  it('a pane with no launch row reports no_row — nothing to compare against', async () => {
    const db = rawDb()
    const result = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-a',
      anchorCorroborated: true,
      anchorHostVerified: false,
      sessionStartSource: 'fork',
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    expect(result).toEqual({ kind: 'no_row' })
  })

  // [S10-21c B4, design §2 S3] SCENARIO CORRECTION of the pre-B4 T30 test, which asserted that
  // `anchorCorroborated` + source 'fork' rotates. B4 replaces conjunct 1 with the strictly
  // stronger `anchorHostVerified` (the runtime's own verdict, never the hook server's continuity
  // cache), so that exact input must now REFUSE. The capability the old test covered has not
  // been dropped — it moved to agent-lineage-live-report.test.ts under the new conjuncts.
  it('S10-21c B4 (tightening guard): anchorCorroborated true but anchorHostVerified FALSE — no rotation, alarm as before, row unchanged', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = await evaluateLiveHookReportMismatch(
      db,
      {
        hostId: HOST_ID,
        paneKey: PANE,
        reportedSessionId: 'sess-b',
        anchorCorroborated: true,
        anchorHostVerified: false,
        sessionStartSource: 'fork',
        launchGeneration: GEN
      },
      REAL_TRANSCRIPT
    )
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.evidence).toBe('host_launch')
    expect(currentSessionRow(db, PANE)?.session_id).toBe('sess-a')
    expect(auditRows(db, PANE)).toHaveLength(1)
  })

  // [S10-21c B4, design §2 S3] SCENARIO CORRECTION of the pre-B4 "source 'startup' does NOT
  // satisfy conjunct 4" test: conjunct 4 is DROPPED (chair synthesis, "Drop conjunct 4"), so the
  // source value no longer gates anything. It is now recorded as evidence in the audit instead.
  it("S10-21c B4: conjunct 4 is dropped — a host-verified 'startup'-sourced report reconciles, and the source rides the audit as evidence", async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = await evaluateLiveHookReportMismatch(
      db,
      {
        hostId: HOST_ID,
        paneKey: PANE,
        reportedSessionId: 'sess-b',
        anchorCorroborated: true,
        anchorHostVerified: true,
        sessionStartSource: 'startup',
        launchGeneration: GEN
      },
      REAL_TRANSCRIPT
    )
    expect(result.kind).toBe('reconciled')
    if (result.kind === 'reconciled') {
      expect(result.row.session_id).toBe('sess-b')
      expect(result.row.previous_session_id).toBe('sess-a')
      expect(result.row.evidence).toBe('live_report')
    }
    expect(currentSessionRow(db, PANE)?.session_id).toBe('sess-b')
    const rows = auditRows(db, PANE)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      outcome: 'reconciled',
      reason_code: 'recorded=sess-a reported=sess-b source=startup'
    })
  })

  it('T31 (anchor clause; previous-id clause retired by errata 5(ab)): anchor not corroborated — foreign-id mismatch, alarm, row unchanged', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: 'fork',
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
    const rows = auditRows(db, PANE)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      outcome: 'contested',
      reason_code: 'recorded=sess-a reported=sess-b'
    })
  })

  it('no SessionStart observed at all AND no host verdict — alarm, row unchanged (the host verdict is what refuses; the absent source no longer gates: see agent-lineage-live-report.test.ts)', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const result = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: true,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
  })

  it("T33: every conjunct holds but the successor collides with another pane's newest id — alarm, row unchanged", async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a', PANE)
    seedLaunch(db, 'sess-victim', 'tab2:leaf-b')
    // [S10-21c B4] EVERY other conjunct is satisfied — host-verified, exact pane, real
    // transcript — so `current_sessions` UNIQUE is provably the thing that refuses here.
    const result = await evaluateLiveHookReportMismatch(
      db,
      {
        hostId: HOST_ID,
        paneKey: PANE,
        reportedSessionId: 'sess-victim',
        anchorCorroborated: true,
        anchorHostVerified: true,
        sessionStartSource: 'fork',
        launchGeneration: GEN
      },
      REAL_TRANSCRIPT
    )
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
    expect(newestLaunchForPane(db, HOST_ID, 'tab2:leaf-b')?.session_id).toBe('sess-victim')
    expect(currentSessionRow(db, 'tab2:leaf-b')?.session_id).toBe('sess-victim')
  })

  it('D-R107 MEDIUM-1/fix item 2: a pane that moved tabs (same suffix, new tabId prefix) is still resolved — no false no_row', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a', 'tab-OLD:leaf-a')
    const result = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: 'tab-NEW:leaf-a',
      reportedSessionId: 'sess-a',
      anchorCorroborated: true,
      anchorHostVerified: false,
      sessionStartSource: 'fork',
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    expect(result).toEqual({ kind: 'match' })
  })

  it('Ruling 34 Addendum 18/20: two DIFFERENT mismatches (each a new fact) produce TWO audit rows', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const first = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    const second = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-c',
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    expect(first).toEqual({ kind: 'foreign_mismatch' })
    expect(second).toEqual({ kind: 'foreign_mismatch' })
    expect(auditRows(db, PANE)).toHaveLength(2)
  })

  it('Ruling 34 Addendum 20: a REPEATED identical mismatch (same recorded/reported pair) is DEDUPED — one audit row, not clamped away', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const first = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    const second = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b', // identical reported id — the SAME fact as `first`
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    expect(first).toEqual({ kind: 'foreign_mismatch' })
    expect(second).toEqual({ kind: 'foreign_mismatch' })
    const rows = auditRows(db, PANE)
    expect(rows).toHaveLength(1)
    expect(rows[0].reason_code).toBe('recorded=sess-a reported=sess-b')
  })

  it('Ruling 34 Addendum 20: a CHANGED reported id after a dedupe run still writes a NEW row', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b', // duplicate — deduped
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-c', // a NEW fact — must audit regardless of the dedupe above
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    const rows = auditRows(db, PANE)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.reason_code)).toEqual([
      'recorded=sess-a reported=sess-b',
      'recorded=sess-a reported=sess-c'
    ])
  })

  // ---- D-R108 R1: the unrecorded_launch downgrade ----

  it('D-R108 R1: a pane whose newest admission audit (any verb) this generation IS unrecorded classifies unrecorded_launch', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    writeAdmissionAudit(db, 'launch_unrecorded', 'pane_key_owned')
    const result = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
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

  it('D-R108 R1(a): after an UNRECORDED admission, a LATER admission audit of a DIFFERENT verb (not unrecorded) restores normal classification', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    writeAdmissionAudit(db, 'launch_unrecorded', 'pane_key_owned', PANE, '+1 second')
    writeAdmissionAudit(db, 'launch_refused', 'some_refusal', PANE, '+2 seconds')
    const result = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    expect(result).toEqual({ kind: 'foreign_mismatch' })
  })

  it('D-R108 R1(a)/(test list): after an UNRECORDED admission, a LATER HOST_MINTED launch (no audit row, but a fresher recorded row) restores normal classification', async () => {
    const db = rawDb()
    writeAdmissionAudit(db, 'launch_unrecorded', 'pane_key_owned', PANE, '-1 second')
    seedLaunch(db, 'sess-a') // the "later HOST_MINTED launch" — recorded_at is now
    const result = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    expect(result).toEqual({ kind: 'foreign_mismatch' })
  })

  it('D-R108 R1(b): a PRIOR-GENERATION unrecorded audit does not downgrade — the launch row is from a different generation', async () => {
    const db = rawDb()
    // The row's own generation differs from what the live pane now reports under.
    seedLaunch(db, 'sess-a', PANE, 'gen-0')
    writeAdmissionAudit(db, 'launch_unrecorded', 'pane_key_owned', PANE, '+1 second')
    const result = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: 'gen-1' // the CURRENT generation, distinct from the row's 'gen-0'
    }, REAL_TRANSCRIPT)
    expect(result).toEqual({ kind: 'foreign_mismatch' })
  })

  it('D-R108 (test list): a foreign mismatch after a pane_key_owned UNRECORDED admission from a different caller is still contested when a recorded launch is newer', async () => {
    const db = rawDb()
    writeAdmissionAudit(db, 'launch_unrecorded', 'pane_key_owned', PANE, '-5 seconds')
    seedLaunch(db, 'sess-a') // the recorded launch, newer than the unrecorded admission above
    const result = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    const rows = db
      .prepare(
        `SELECT outcome FROM agent_audit WHERE actor_pane_key = ? AND verb = 'session_identity_mismatch'`
      )
      .all(PANE) as { outcome: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('contested')
  })

  it('D-R108 R1(c): the admission audit is resolved by pane SUFFIX, same rule as the launch row', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a', 'tab-OLD:leaf-a')
    writeAdmissionAudit(db, 'launch_unrecorded', 'pane_key_owned', 'tab-OLD:leaf-a', '+1 second')
    const result = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: 'tab-NEW:leaf-a',
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    expect(result).toEqual({ kind: 'unrecorded_launch', reason: 'pane_key_owned' })
  })

  it("fence: no path here writes current_sessions directly — only recordSelfReportRotation's own accepted-rotation upsert does", async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a')
    const before = currentSessionRow(db, PANE)
    await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    expect(currentSessionRow(db, PANE)).toEqual(before)
  })

  it("[S10-21a C12b, D-R125 F2] an uncorroborated report naming a DIFFERENT pane than the row it resolves to (forged pane key, real leaf suffix) audits under the row's REAL pane, names the claimant, never trusts the claimed key", async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-a', PANE) // PANE = 'tab1:leaf-a' — the real, registered pane.
    const forgedPaneKey = 'forged-tab:leaf-a' // same suffix (resolves to PANE's row), forged prefix.
    const result = await evaluateLiveHookReportMismatch(db, {
      hostId: HOST_ID,
      paneKey: forgedPaneKey,
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      anchorHostVerified: false,
      sessionStartSource: undefined,
      launchGeneration: GEN
    }, REAL_TRANSCRIPT)
    expect(result).toEqual({ kind: 'foreign_mismatch', attributedPaneKey: PANE })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-a')
    // Audited under the row's REAL pane key — never the forged claimant.
    expect(auditRows(db, forgedPaneKey)).toHaveLength(0)
    const rows = auditRows(db, PANE)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      outcome: 'contested',
      reason_code: `recorded=sess-a reported=sess-b uncorroborated_claimant=${forgedPaneKey}`
    })
  })
})
