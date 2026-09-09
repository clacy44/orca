// S10-21d b3c (D-R163 M3 negative 5): the hook path (S3 reconciliation / S5 bootstrap, both
// inside `evaluateLiveHookReportMismatch`) never consults incumbent-death/dead-holder-adoption —
// it is a pane-locality + `current_sessions` UNIQUE check only. This proves a report naming a
// session whose holder pane is in the exact shape `resolveHolderAdoption` (dead-holder-
// adoption.ts) would call DEAD — prior launch_generation, no live pty, no registered row identity
// match set at all — still refuses byte-identically to the base's own cross-pane assertions
// (agent-lineage-live-report.test.ts:220 S3 conjunct (iv), :419 S5 conjunct (iv)): the hook
// channel has no adoption arm, so a dead holder buys a hook report nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import {
  evaluateLiveHookReportMismatch,
  resetNegativeTranscriptVerdictCacheForTests,
  type LiveHookReportMismatchParams,
  type ResolveLiveReportTranscript
} from './agent-lineage-mismatch'
import { newestLaunchForPane, recordLaunch } from './agent-launch-sessions'
import { OrchestrationDb } from './db'

const HOST_ID = 'local'
const PANE = 'tab1:leaf-a'
// [dead shape] a prior launch_generation, distinct from the report's own GEN — the same
// generation-mismatch shape dead-holder-adoption.ts's conjunct C reads as "not this generation".
const VICTIM_PANE = 'tab9:leaf-victim'
const VICTIM_GEN = 'gen-0'
const GEN = 'gen-1'

const REAL: ResolveLiveReportTranscript = async () => ({
  path: '/transcripts/real.jsonl',
  hasTurn: true
})

describe('D-R163 M3 negative 5: the hook path (S3/S5) is unaffected by a DEAD holder', () => {
  let orchestrationDb: OrchestrationDb | undefined

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
    const reportedAgentType = over.reportedAgentType ?? 'claude'
    return {
      hostId: HOST_ID,
      paneKey: PANE,
      reportedSessionId: 'sess-live',
      anchorCorroborated: true,
      anchorHostVerified: true,
      sessionStartSource: 'resume',
      launchGeneration: GEN,
      reportedAgentType,
      reportedSource: reportedAgentType,
      executionHostId: 'local',
      ...over
    }
  }

  function seedVictimLaunch(db: Database.Database, sessionId: string): void {
    // [dead shape] launch_generation VICTIM_GEN (prior, unlike the reporting pane's own GEN) and
    // no registered `agents` row at all for VICTIM_PANE — a holder dead-holder-adoption.ts's own
    // conjunct C (holder generation != current generation) would treat as eligible for the
    // GEN_ABSENCE/D1/IDENTITY branch, were this the launcher-restore rail. This evaluator never
    // reads launch_generation, process_incarnation, or any liveness signal, so the shape is inert
    // here — that is exactly the point being proven.
    const result = recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: VICTIM_PANE,
      agentType: 'claude',
      sessionId,
      launchGeneration: VICTIM_GEN,
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    if (!result.ok) {
      throw new Error('fixture seed failed')
    }
  }

  function insertAgent(db: Database.Database, id: string, displayName: string, paneKey: string) {
    db.prepare(
      `INSERT INTO agents (
         id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
         worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
         quarantined_at, tombstoned_at, origin_kind, origin_pane_key, origin_handle,
         origin_host_id
       ) VALUES (?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'idle', 0, 0,
         NULL, NULL, 'pane', ?, NULL, ?)`
    ).run(id, displayName, HOST_ID, paneKey, paneKey, HOST_ID)
  }

  function currentSessionPane(db: Database.Database, sessionId: string): string | undefined {
    return (
      db
        .prepare('SELECT pane_key FROM current_sessions WHERE host_id = ? AND session_id = ?')
        .get(HOST_ID, sessionId) as { pane_key: string } | undefined
    )?.pane_key
  }

  it('S3 conjunct (iv) with a DEAD-shaped victim: still `foreign_mismatch`, victim untouched — same as the base (agent-lineage-live-report.test.ts:220)', async () => {
    const db = rawDb()
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
      agentType: 'claude',
      sessionId: 'sess-mine',
      launchGeneration: GEN,
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    seedVictimLaunch(db, 'sess-victim')
    const result = await evaluateLiveHookReportMismatch(
      db,
      params({ reportedSessionId: 'sess-victim' }),
      REAL
    )
    expect(result).toEqual({ kind: 'foreign_mismatch' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)?.session_id).toBe('sess-mine')
    expect(newestLaunchForPane(db, HOST_ID, VICTIM_PANE)?.session_id).toBe('sess-victim')
    expect(currentSessionPane(db, 'sess-victim')).toBe(VICTIM_PANE)
  })

  it('S5 conjunct (iv) with a DEAD-shaped victim: still `bootstrap_refused foreign_session_id`, victim untouched — same as the base (agent-lineage-live-report.test.ts:419)', async () => {
    const db = rawDb()
    insertAgent(db, 'agt_1', 'vps-services', PANE)
    seedVictimLaunch(db, 'sess-victim')
    const result = await evaluateLiveHookReportMismatch(
      db,
      params({ reportedSessionId: 'sess-victim' }),
      REAL
    )
    expect(result).toEqual({ kind: 'bootstrap_refused', reason: 'foreign_session_id sess-victim' })
    expect(newestLaunchForPane(db, HOST_ID, PANE)).toBeUndefined()
    expect(newestLaunchForPane(db, HOST_ID, VICTIM_PANE)?.session_id).toBe('sess-victim')
    expect(currentSessionPane(db, 'sess-victim')).toBe(VICTIM_PANE)
  })
})
