// S10-21c B-final F7 (D-R159 finding 6): evaluateLiveHookReportMismatch's optional re-verify
// callback re-checks conjunct (i) in the same tick as the reconciliation write — anchorHostVerified
// is a SNAPSHOT stamped at hook ingestion and can be stale by the time the transcript await
// returns. Split out of agent-lineage-live-report.test.ts (near the 800-line test cap) per
// _common-rules.md's "split modules if needed and say so".
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import {
  evaluateLiveHookReportMismatch,
  type LiveHookReportMismatchParams,
  type ResolveLiveReportTranscript
} from './agent-lineage-mismatch'
import { newestLaunchForPane, recordLaunch } from './agent-launch-sessions'
import { OrchestrationDb } from './db'

const HOST_ID = 'local'
const PANE = 'tab1:leaf-a'
const GEN = 'gen-1'

const REAL: ResolveLiveReportTranscript = async () => ({
  path: '/transcripts/real.jsonl',
  hasTurn: true
})

describe('S10-21c B-final F7, D-R159 finding 6: evaluateLiveHookReportMismatch re-verify callback', () => {
  let orchestrationDb: OrchestrationDb | undefined

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

  function seedLaunch(db: Database.Database, sessionId: string) {
    const result = recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: PANE,
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

  it('a re-verify callback that now returns false refuses the reconciliation — the row is left untouched, not reconciled (fails at base: base has no re-verify callback)', async () => {
    const db = rawDb()
    const seeded = seedLaunch(db, 'sess-stub')
    const reverify = vi.fn(() => false)
    const result = await evaluateLiveHookReportMismatch(db, params(), REAL, reverify)
    expect(result.kind).not.toBe('reconciled')
    expect(reverify).toHaveBeenCalledWith(PANE)
    const row = newestLaunchForPane(db, HOST_ID, PANE)
    expect(row?.seq).toBe(seeded.seq)
    expect(row?.session_id).toBe('sess-stub') // untouched — never reconciled onto sess-live
  })

  it('a re-verify callback that still returns true reconciles exactly as the snapshot alone would', async () => {
    const db = rawDb()
    seedLaunch(db, 'sess-stub')
    const reverify = vi.fn(() => true)
    const result = await evaluateLiveHookReportMismatch(db, params(), REAL, reverify)
    expect(result.kind).toBe('reconciled')
    expect(reverify).toHaveBeenCalledWith(PANE)
  })
})
