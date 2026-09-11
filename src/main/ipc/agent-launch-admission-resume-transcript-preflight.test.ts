// S10-21c B-final F4 (D-R159 finding 4): caller_resume's UUID-shaped selector must also name a
// REAL, turn-carrying transcript before it is recorded — split out of agent-launch-admission
// .test.ts (near the 800-line test cap) per _common-rules.md's "split modules if needed and say
// so".
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { admitAgentLaunch, type LaunchAdmission } from './agent-launch-admission'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type * as NodeCrypto from 'node:crypto'

const MINTED_A = '11111111-1111-4111-8111-111111111111'
const REAL_CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>()
  return { ...actual, randomUUID: vi.fn(() => MINTED_A) }
})

vi.mock('../startup/resolve-resume-transcript', () => ({
  resolveResumeTranscript: vi.fn(async () => ({ path: '/fake/transcript.jsonl', hasTurn: true }))
}))

import { randomUUID } from 'node:crypto'
import { resolveResumeTranscript } from '../startup/resolve-resume-transcript'

const CALLER: LaunchAdmission = { kind: 'caller' }
const HOST_ID = 'local'

describe('S10-21c B-final F4, D-R159 finding 4: caller_resume resume-transcript preflight', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    vi.mocked(randomUUID).mockReturnValue(MINTED_A)
    vi.mocked(resolveResumeTranscript).mockReset()
    vi.mocked(resolveResumeTranscript).mockResolvedValue({
      path: '/fake/transcript.jsonl',
      hasTurn: true
    })
    orchestrationDb?.close()
  })

  function freshDb(): OrchestrationDb {
    orchestrationDb = new OrchestrationDb(':memory:')
    return orchestrationDb
  }

  function rawDb(db: OrchestrationDb): Database.Database {
    return (db as unknown as { db: Database.Database }).db
  }

  function ctx(overrides: Partial<Parameters<typeof admitAgentLaunch>[3]> = {}) {
    return {
      hostId: HOST_ID,
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      notice: () => {},
      contestedLineage: () => {},
      findConnectedPtyForPane: () => false,
      ...overrides
    }
  }

  function opts(overrides: Partial<PtySpawnOptions> = {}): PtySpawnOptions {
    return { cols: 80, rows: 24, launchAgent: 'claude', paneKey: 'tab1:leaf-a', ...overrides }
  }

  it("a caller's `claude --resume X` where X is UUID-shaped but names NO transcript is UNRECORDED (resume_target_absent) — no row, spawn still proceeds", async () => {
    const db = freshDb()
    vi.mocked(resolveResumeTranscript).mockResolvedValue(null)
    const notices: { paneKey: string; verb: string; reasonCode: string }[] = []
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: `claude --resume ${REAL_CONVERSATION_ID}` }),
      CALLER,
      ctx({ notice: (paneKey, verb, reasonCode) => notices.push({ paneKey, verb, reasonCode }) })
    )
    expect(admitted.spawnOptions.command).toBe(`claude --resume ${REAL_CONVERSATION_ID}`)
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    expect(notices).toEqual([
      { paneKey: 'tab1:leaf-a', verb: 'launch_unrecorded', reasonCode: 'resume_target_absent' }
    ])
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_unrecorded')
    expect(auditRow.reason_code).toBe('resume_target_absent')
  })

  it("a caller's `claude --resume X` naming a REAL, turn-carrying transcript is RECORDED with evidence 'caller_resume'", async () => {
    const db = freshDb()
    vi.mocked(resolveResumeTranscript).mockResolvedValue({
      path: '/fake/real-conversation.jsonl',
      hasTurn: true
    })
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: `claude --resume ${REAL_CONVERSATION_ID}` }),
      CALLER,
      ctx()
    )
    expect(admitted.spawnOptions.command).toBe(`claude --resume ${REAL_CONVERSATION_ID}`)
    const row = db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')
    expect(row?.session_id).toBe(REAL_CONVERSATION_ID)
    expect(row?.evidence).toBe('caller_resume')
  })

  // [S10-21c B-final M2, D-R160 medium 2] A throwing resolver (a transcript-file race, EACCES,
  // EMFILE) must never fail the spawn — loud `unrecorded`, no row, no throw out of the pane lock.
  it('a resolveResumeTranscript that THROWS is unrecorded (resume_preflight_failed), no row, and the spawn still proceeds — fails at base: base had no try/catch here', async () => {
    const db = freshDb()
    vi.mocked(resolveResumeTranscript).mockRejectedValue(new Error('EACCES'))
    const notices: { paneKey: string; verb: string; reasonCode: string }[] = []
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: `claude --resume ${REAL_CONVERSATION_ID}` }),
      CALLER,
      ctx({ notice: (paneKey, verb, reasonCode) => notices.push({ paneKey, verb, reasonCode }) })
    )
    expect(admitted.spawnOptions.command).toBe(`claude --resume ${REAL_CONVERSATION_ID}`)
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    expect(notices).toEqual([
      {
        paneKey: 'tab1:leaf-a',
        verb: 'launch_unrecorded',
        reasonCode: 'resume_preflight_failed'
      }
    ])
  })

  // [S10-21c B-final M3, D-R160 medium 3] `{coverage:'uncovered'}` is a distinct reason from a
  // genuine miss — S4's own `decideResumePreflight` treats "not covered yet" as never a refusal
  // of a MISSING target; this arm's audit must not claim the wrong cause either.
  it("{coverage:'uncovered'} is unrecorded resume_preflight_uncovered, never resume_target_absent", async () => {
    const db = freshDb()
    vi.mocked(resolveResumeTranscript).mockResolvedValue({ coverage: 'uncovered' })
    const notices: { paneKey: string; verb: string; reasonCode: string }[] = []
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: `claude --resume ${REAL_CONVERSATION_ID}` }),
      CALLER,
      ctx({ notice: (paneKey, verb, reasonCode) => notices.push({ paneKey, verb, reasonCode }) })
    )
    expect(admitted.spawnOptions.command).toBe(`claude --resume ${REAL_CONVERSATION_ID}`)
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    expect(notices).toEqual([
      {
        paneKey: 'tab1:leaf-a',
        verb: 'launch_unrecorded',
        reasonCode: 'resume_preflight_uncovered'
      }
    ])
  })
})
