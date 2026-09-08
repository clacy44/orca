// S10-21c B4 (design §2 S3 + §2 S5; OD-B / INV-P-020 amendment #1, UNRATIFIED): the
// host-verified live-report RECONCILIATION and the registered-pane row BOOTSTRAP, fenced
// conjunct by conjunct. The pre-B4 detection/contest behaviour is fenced in
// agent-lineage-mismatch.test.ts; this file only covers what B4 adds.
//
// The two questions every case here answers, in the order framing B's attacks pose them:
//   - can a report move ANOTHER pane's row?    (conjunct (ii) exact match, conjunct (iv) UNIQUE)
//   - can a report establish a NEW identity?   (S5's registered/non-derived/non-quarantined gate)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import {
  evaluateLiveHookReportMismatch,
  resetNegativeTranscriptVerdictCacheForTests,
  type LiveHookReportMismatchParams,
  type ResolveLiveReportTranscript
} from './agent-lineage-mismatch'
import { newestLaunchForPane, recordLaunch } from './agent-launch-sessions'
import type { AgentRow } from './agent-directory-types'
import { OrchestrationDb } from './db'

const HOST_ID = 'local'
const PANE = 'tab1:leaf-a'
const SIBLING = 'tab2:leaf-a' // SAME leaf suffix as PANE — what the suffix lookups resolve to.
const GEN = 'gen-1'

const REAL: ResolveLiveReportTranscript = async () => ({
  path: '/transcripts/real.jsonl',
  hasTurn: true
})
const STUB_ONLY: ResolveLiveReportTranscript = async () => ({
  path: '/transcripts/stub.jsonl',
  hasTurn: false
})
const MISSING: ResolveLiveReportTranscript = async () => null
const UNCOVERED: ResolveLiveReportTranscript = async () => ({ coverage: 'uncovered' })

describe('S10-21c B4: live-report reconciliation (S3) and row bootstrap (S5)', () => {
  let orchestrationDb: OrchestrationDb | undefined

  // [S10-21c B4b, D-R152-b4 finding 2] The negative-transcript memo cache is module-scoped and
  // outlives any one `it()` — this file reuses PANE/session ids with a negative resolver across
  // cases, so a stale cache entry would leak a stale verdict into the next case.
  beforeEach(() => {
    resetNegativeTranscriptVerdictCacheForTests()
  })

  afterEach(() => {
    orchestrationDb?.close()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function params(over: Partial<LiveHookReportMismatchParams> = {}): LiveHookReportMismatchParams {
    return {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-live',
      anchorCorroborated: true,
      anchorHostVerified: true,
      sessionStartSource: 'resume',
      launchGeneration: GEN,
      reportedAgentType: 'claude',
      executionHostId: 'local',
      ...over
    }
  }

  function seedLaunch(db: Database.Database, sessionId: string, paneKey = PANE) {
    const result = recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId,
      launchGeneration: GEN,
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    if (!result.ok) {
      throw new Error('seed failed')
    }
    return result.row
  }

  function insertAgent(
    db: Database.Database,
    over: Partial<AgentRow> & { id: string; display_name: string; pane_key: string | null }
  ): void {
    db.prepare(
      `INSERT INTO agents (
         id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
         worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
         quarantined_at, tombstoned_at, origin_kind, origin_pane_key, origin_handle,
         origin_host_id
       ) VALUES (?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'idle', ?, ?, NULL,
         NULL, ?, ?, NULL, ?)`
    ).run(
      over.id,
      over.display_name,
      over.host_id ?? HOST_ID,
      over.pane_key,
      over.derived ?? 0,
      over.quarantined ?? 0,
      over.derived === 1 ? 'derived' : 'pane',
      over.pane_key,
      HOST_ID
    )
  }

  function audits(db: Database.Database, paneKey: string, verb: string) {
    return db
      .prepare(
        `SELECT outcome, reason_code FROM agent_audit
           WHERE actor_pane_key = ? AND verb = ? ORDER BY seq`
      )
      .all(paneKey, verb) as { outcome: string; reason_code: string | null }[]
  }

  function currentSessionPane(db: Database.Database, sessionId: string): string | undefined {
    return (
      db
        .prepare('SELECT pane_key FROM current_sessions WHERE host_id = ? AND session_id = ?')
        .get(HOST_ID, sessionId) as { pane_key: string } | undefined
    )?.pane_key
  }

  // ---------------------------------------------------------------- S3: reconciliation ------

  it('S3 positive: a host-verified report on its OWN pane corrects that row in place, evidence live_report, audit outcome reconciled', async () => {
    const db = rawDb()
    const seeded = seedLaunch(db, 'sess-stub')
    const result = await evaluateLiveHookReportMismatch(db, params(), REAL)
    expect(result.kind).toBe('reconciled')
    if (result.kind !== 'reconciled') {
      return
    }
    expect(result.row.seq).toBe(seeded.seq) // updated IN PLACE — never a second row
    expect(result.row.session_id).toBe('sess-live')
    expect(result.row.previous_session_id).toBe('sess-stub')
    expect(result.row.evidence).toBe('live_report')
    expect(currentSessionPane(db, 'sess-live')).toBe(PANE)
    const rows = audits(db, PANE, 'session_identity_mismatch')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      outcome: 'reconciled',
      reason_code: 'recorded=sess-stub reported=sess-live source=resume'
    })
  })

  it("S3: the shell-typed relaunch shape — source 'resume' — reconciles (this is the case the pre-B4 fork-only conjunct made permanently impossible)", async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-stub')
    const result = await evaluateLiveHookReportMismatch(
      db,
      params({ sessionStartSource: 'resume' }),
      REAL
    )
    expect(result.kind).toBe('reconciled')
  })

  it('S3: conjunct 4 is DROPPED, not loosened — a report with NO sessionStartSource at all still reconciles, and the audit records the absence', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-stub')
    const result = await evaluateLiveHookReportMismatch(
      db,
      params({ sessionStartSource: undefined }),
      REAL
    )
    expect(result.kind).toBe('reconciled')
    expect(audits(db, PANE, 'session_identity_mismatch')[0]?.reason_code).toBe(
      'recorded=sess-stub reported=sess-live source=none'
    )
  })

  it('S3 conjunct (i): without the runtime verdict there is no reconciliation, however corroborated the hook server believes the pane to be', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-stub')
    const result = await evaluateLiveHookReportMismatch(
      db,
      params({ anchorHostVerified: false }),
      REAL
    )
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-stub')
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.evidence).toBe('host_launch')
  })

  it("S3 conjunct (ii) — CROSS-PANE: a report from a pane whose row the SUFFIX lookup resolves to a SIBLING never touches that sibling's row; a CORROBORATED claimant is attributed to the REPORTING pane, never re-attributed to the sibling", async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-sibling', SIBLING)
    const result = await evaluateLiveHookReportMismatch(db, params({ paneKey: PANE }), REAL)
    // The suffix lookup found SIBLING's row; conjunct (ii) refuses to reconcile it.
    expect(result.kind).toBe('foreign_mismatch')
    const sibling = newestLaunchForPane(db, HOST_ID, SIBLING)
    expect(sibling?.session_id).toBe('sess-sibling')
    expect(sibling?.evidence).toBe('host_launch')
    expect(sibling?.previous_session_id).toBeNull()
    expect(currentSessionPane(db, 'sess-sibling')).toBe(SIBLING)
    expect(currentSessionPane(db, 'sess-live')).toBeUndefined()
    // No row was created for the reporting pane either: reconciliation never inserts.
    expect(newestLaunchForPane(db, HOST_ID, PANE)).toBeUndefined()
    // [S10-21c B4b, D-R152-b4 finding 8] `params()` defaults `anchorCorroborated: true` — the
    // claimant IS authenticated for ITSELF, so the audit charges the REPORTING pane (PANE), not
    // `row.pane_key` (SIBLING). Re-attribution to the row's owner is reserved for an
    // UNCORROBORATED claim naming a different pane (raiseMismatchAlarm's own F2/D-R125 case).
    expect(audits(db, PANE, 'session_identity_mismatch')).toHaveLength(1)
    expect(audits(db, SIBLING, 'session_identity_mismatch')).toHaveLength(0)
  })

  it("S3 conjunct (iv) — CROSS-PANE: a report naming a session another pane currently holds is refused by current_sessions UNIQUE, never absorbed, and the victim's row is untouched", async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-mine', PANE)
    seedLaunch(db, 'sess-victim', 'tab9:leaf-victim')
    const result = await evaluateLiveHookReportMismatch(
      db,
      params({ reportedSessionId: 'sess-victim' }),
      REAL
    )
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-mine')
    expect(newestLaunchForPane(db, HOST_ID, 'tab9:leaf-victim')?.session_id).toBe('sess-victim')
    expect(currentSessionPane(db, 'sess-victim')).toBe('tab9:leaf-victim')
  })

  it('S3 conjunct (iii): a stub-only transcript refuses, and the alarm reason code is unchanged (no note)', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-stub')
    const result = await evaluateLiveHookReportMismatch(db, params(), STUB_ONLY)
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-stub')
    expect(audits(db, PANE, 'session_identity_mismatch')[0]?.reason_code).toBe(
      'recorded=sess-stub reported=sess-live'
    )
  })

  it('S3 conjunct (iii): a missing transcript refuses, alarm reason code unchanged', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-stub')
    const result = await evaluateLiveHookReportMismatch(db, params(), MISSING)
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-stub')
    expect(audits(db, PANE, 'session_identity_mismatch')[0]?.reason_code).toBe(
      'recorded=sess-stub reported=sess-live'
    )
  })

  it("S3 conjunct (iii), THIRD state: {coverage:'uncovered'} refuses and carries S4's resume_preflight_uncovered code into the alarm's own audit row", async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-stub')
    const result = await evaluateLiveHookReportMismatch(db, params(), UNCOVERED)
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-stub')
    expect(audits(db, PANE, 'session_identity_mismatch')[0]?.reason_code).toBe(
      'recorded=sess-stub reported=sess-live resume_preflight_uncovered claude'
    )
  })

  it('S3: the transcript conjunct is asked about the REPORTED id under the ROW’s recorded agent type — never a hook-chosen one', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-stub')
    const seen: [string, string][] = []
    const spy: ResolveLiveReportTranscript = async (agentType, sessionId) => {
      seen.push([agentType, sessionId])
      return { path: '/t.jsonl', hasTurn: true }
    }
    await evaluateLiveHookReportMismatch(db, params({ reportedAgentType: 'codex' }), spy)
    expect(seen).toEqual([['claude', 'sess-live']])
  })

  it('S3: a second report of the SAME id after a reconciliation is a plain match — the mismatch stops repeating (R1 closed)', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-stub')
    expect((await evaluateLiveHookReportMismatch(db, params(), REAL)).kind).toBe('reconciled')
    expect(await evaluateLiveHookReportMismatch(db, params(), REAL)).toEqual({ kind: 'match' })
    expect(audits(db, PANE, 'session_identity_mismatch')).toHaveLength(1)
  })

  // ---------------------------------------------------------------------- S5: bootstrap -----

  it('S5 positive: a registered, non-derived, non-quarantined pane with NO row gets one, evidence self_report_bootstrap, agent_id bound', async () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_1', display_name: 'vps-services', pane_key: PANE })
    const result = await evaluateLiveHookReportMismatch(db, params(), REAL)
    expect(result.kind).toBe('bootstrapped')
    const row = newestLaunchForPane(db, HOST_ID, PANE)
    expect(row?.session_id).toBe('sess-live')
    expect(row?.evidence).toBe('self_report_bootstrap')
    expect(row?.agent_id).toBe('agt_1')
    expect(row?.agent_type).toBe('claude')
    expect(row?.execution_host_id).toBe('local')
    expect(row?.launch_generation).toBe(GEN)
    // INV-P-021: a bootstrap is not a restore — no pane-to-pane move is involved.
    expect(row?.previous_session_id).toBeNull()
    expect(currentSessionPane(db, 'sess-live')).toBe(PANE)
    expect(audits(db, PANE, 'session_identity_bootstrap')).toEqual([
      { outcome: 'bootstrapped', reason_code: 'session=sess-live agent_type=claude' }
    ])
  })

  it('S5: the bootstrap is idempotent — the second report of the same id is a match, and no second row appears', async () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_1', display_name: 'vps-services', pane_key: PANE })
    expect((await evaluateLiveHookReportMismatch(db, params(), REAL)).kind).toBe('bootstrapped')
    expect(await evaluateLiveHookReportMismatch(db, params(), REAL)).toEqual({ kind: 'match' })
    const rows = db
      .prepare('SELECT seq FROM agent_launch_sessions WHERE host_id = ? AND pane_key = ?')
      .all(HOST_ID, PANE) as { seq: number }[]
    expect(rows).toHaveLength(1)
  })

  it('S5 conjunct (i): no runtime verdict — no_row, nothing written, no audit', async () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_1', display_name: 'vps-services', pane_key: PANE })
    const result = await evaluateLiveHookReportMismatch(
      db,
      params({ anchorHostVerified: false }),
      REAL
    )
    expect(result).toEqual({ kind: 'no_row' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)).toBeUndefined()
    expect(audits(db, PANE, 'session_identity_bootstrap')).toHaveLength(0)
  })

  it('S5 — NEW IDENTITY: a pane with no agent row at all is never bootstrapped (an ordinary terminal cannot mint itself a lineage)', async () => {
    const db = rawDb()
    const result = await evaluateLiveHookReportMismatch(db, params(), REAL)
    expect(result).toEqual({ kind: 'no_row' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)).toBeUndefined()
  })

  it('S5 — NEW IDENTITY: a DERIVED agent row is never bootstrapped', async () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_d', display_name: 'terminal-agent-1', pane_key: PANE, derived: 1 })
    const result = await evaluateLiveHookReportMismatch(db, params(), REAL)
    expect(result).toEqual({ kind: 'no_row' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)).toBeUndefined()
  })

  it('S5 — NEW IDENTITY: a QUARANTINED agent row is never bootstrapped', async () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_q', display_name: 'fenced', pane_key: PANE, quarantined: 1 })
    const result = await evaluateLiveHookReportMismatch(db, params(), REAL)
    expect(result).toEqual({ kind: 'no_row' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)).toBeUndefined()
  })

  it("S5 — CROSS-PANE: getAgentByPaneKey matches by SUFFIX, so a sibling pane's registered row must not license a bootstrap; the exact-match check is what refuses", async () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_sib', display_name: 'sibling-chair', pane_key: SIBLING })
    const result = await evaluateLiveHookReportMismatch(db, params({ paneKey: PANE }), REAL)
    expect(result).toEqual({ kind: 'no_row' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)).toBeUndefined()
    expect(newestLaunchForPane(db, HOST_ID, SIBLING)).toBeUndefined()
  })

  it("S5 conjunct (iv) — CROSS-PANE: a reported id another pane currently holds is refused by recordLaunch's UNIQUE fence; no row, victim untouched, refusal audited", async () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_1', display_name: 'vps-services', pane_key: PANE })
    seedLaunch(db, 'sess-victim', 'tab9:leaf-victim')
    const result = await evaluateLiveHookReportMismatch(
      db,
      params({ reportedSessionId: 'sess-victim' }),
      REAL
    )
    // [S10-21c B4b, D-R152-b4 finding 2] DISTINCT from the ordinary `no_row` (unregistered/
    // unverified) cases above: this refusal reached conjunct (iv) and is worth noticing once.
    expect(result).toEqual({ kind: 'bootstrap_refused', reason: 'foreign_session_id sess-victim' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)).toBeUndefined()
    expect(newestLaunchForPane(db, HOST_ID, 'tab9:leaf-victim')?.session_id).toBe('sess-victim')
    expect(currentSessionPane(db, 'sess-victim')).toBe('tab9:leaf-victim')
    expect(audits(db, PANE, 'session_identity_bootstrap')).toEqual([
      { outcome: 'refused', reason_code: 'foreign_session_id sess-victim' }
    ])
  })

  it('S5 conjunct (iii): a stub-only transcript refuses with a coded, deduped audit and writes no row; the SECOND (missing-transcript) report never calls its own resolver at all', async () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_1', display_name: 'vps-services', pane_key: PANE })
    const refused = { kind: 'bootstrap_refused', reason: 'resume_target_absent session sess-live' }
    expect(await evaluateLiveHookReportMismatch(db, params(), STUB_ONLY)).toEqual(refused)
    // [S10-21c B4b, D-R152-b4 finding 2] Same (host, pane, reported id), same generation: the
    // negative verdict from the STUB_ONLY call above is memoized, so this MISSING-backed call
    // never invokes its own resolver — proven by a spy in the memoization test below, asserted
    // here only by the identical outcome a fresh call to MISSING would also have produced.
    expect(await evaluateLiveHookReportMismatch(db, params(), MISSING)).toEqual(refused)
    expect(newestLaunchForPane(db, HOST_ID, PANE)).toBeUndefined()
    // Both refusals carry the same code and the same outcome, so the dedupe keeps one row: a
    // pane reporting every few seconds must not flood agent_audit.
    expect(audits(db, PANE, 'session_identity_bootstrap')).toEqual([
      { outcome: 'refused', reason_code: 'resume_target_absent session sess-live' }
    ])
  })

  it("S5 conjunct (iii), THIRD state: {coverage:'uncovered'} refuses with S4's own resume_preflight_uncovered code and writes no row", async () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_1', display_name: 'vps-services', pane_key: PANE })
    const result = await evaluateLiveHookReportMismatch(
      db,
      params({ reportedAgentType: 'nonesuch' }),
      UNCOVERED
    )
    expect(result).toEqual({
      kind: 'bootstrap_refused',
      reason: 'resume_preflight_uncovered nonesuch'
    })
    expect(newestLaunchForPane(db, HOST_ID, PANE)).toBeUndefined()
    expect(audits(db, PANE, 'session_identity_bootstrap')).toEqual([
      { outcome: 'refused', reason_code: 'resume_preflight_uncovered nonesuch' }
    ])
  })

  it('S10-21c B4b, D-R152-b4 finding 2: the negative transcript verdict is memoized per (host, pane, reported id) this generation — a second refused report never calls the resolver again, a different id does, and a new generation does too', async () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_1', display_name: 'vps-services', pane_key: PANE })
    const resolver = vi.fn(STUB_ONLY)
    const refused = (reason: string) => ({ kind: 'bootstrap_refused', reason })

    expect(await evaluateLiveHookReportMismatch(db, params(), resolver)).toEqual(
      refused('resume_target_absent session sess-live')
    )
    expect(resolver).toHaveBeenCalledTimes(1)

    // Same id, same generation — cache hit, resolver not called again.
    expect(await evaluateLiveHookReportMismatch(db, params(), resolver)).toEqual(
      refused('resume_target_absent session sess-live')
    )
    expect(resolver).toHaveBeenCalledTimes(1)

    // A DIFFERENT reported id — cache miss, resolver called again.
    expect(
      await evaluateLiveHookReportMismatch(
        db,
        params({ reportedSessionId: 'sess-other' }),
        resolver
      )
    ).toEqual(refused('resume_target_absent session sess-other'))
    expect(resolver).toHaveBeenCalledTimes(2)

    // A NEW generation — the whole cache is cleared, so the ORIGINAL id is a cache miss again.
    expect(
      await evaluateLiveHookReportMismatch(db, params({ launchGeneration: 'gen-2' }), resolver)
    ).toEqual(refused('resume_target_absent session sess-live'))
    expect(resolver).toHaveBeenCalledTimes(3)
  })

  it('S5: without a host-owned agent type or execution host the bootstrap cannot fire — no row is ever written from a guessed value', async () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_1', display_name: 'vps-services', pane_key: PANE })
    expect(
      await evaluateLiveHookReportMismatch(db, params({ reportedAgentType: undefined }), REAL)
    ).toEqual({ kind: 'no_row' })
    expect(
      await evaluateLiveHookReportMismatch(db, params({ executionHostId: undefined }), REAL)
    ).toEqual({ kind: 'no_row' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)).toBeUndefined()
    expect(audits(db, PANE, 'session_identity_bootstrap')).toHaveLength(0)
  })

  it('S5: the row records the partition the report arrived on — an ssh-partition report is recorded as remote, never silently as local', async () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_1', display_name: 'remote-chair', pane_key: PANE })
    const result = await evaluateLiveHookReportMismatch(
      db,
      params({ executionHostId: 'ssh:conn-1' }),
      REAL
    )
    expect(result.kind).toBe('bootstrapped')
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.execution_host_id).toBe('ssh:conn-1')
  })
})
