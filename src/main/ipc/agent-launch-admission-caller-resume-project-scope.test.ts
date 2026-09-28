// 10z.5 R287 rule 4 (D-R241 A2): with no holder, a caller resume is recorded only when X's
// transcript resolves inside the new pane's own Claude project directory; otherwise it is
// unrecorded (`resume_target_outside_pane_project`) and the spawn proceeds. Fail-open on no cwd.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { admitAgentLaunch } from './agent-launch-admission'
import { resolveResumeTranscript } from '../startup/resolve-resume-transcript'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'

vi.mock('../startup/resolve-resume-transcript', () => ({ resolveResumeTranscript: vi.fn() }))

const X = '44444444-4444-4444-8444-444444444444'
const HOST_ID = 'local'
const PANE = 'tab1:leaf-a'
const HIT = { path: '/fake/transcript.jsonl', hasTurn: true }
const DEFAULT_ROOT = join(homedir(), '.claude', 'projects')

type Options = { claudeProjectsDir?: string }

describe('10z.5 R287 rule 4: transcript must sit in the new pane project', () => {
  let orchestrationDb: OrchestrationDb | undefined
  const resolve = vi.mocked(resolveResumeTranscript)
  afterEach(() => {
    orchestrationDb?.close()
    resolve.mockReset()
  })
  /** Host-wide walk always hits; the scoped walk hits only for the listed project directories. */
  function hitsScoped(...dirs: string[]) {
    resolve.mockImplementation((async (_agent: string, _id: string, options?: Options) =>
      options?.claudeProjectsDir === undefined || dirs.includes(options.claudeProjectsDir)
        ? HIT
        : null) as never)
  }
  function scopedCalls(): (string | undefined)[] {
    return resolve.mock.calls
      .map((c) => (c[2] as Options | undefined)?.claudeProjectsDir)
      .filter((d) => d !== undefined)
  }
  function freshDb(): OrchestrationDb {
    orchestrationDb = new OrchestrationDb(':memory:')
    return orchestrationDb
  }
  function lastAudit(db: OrchestrationDb) {
    return (db as unknown as { db: Database.Database }).db
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; outcome: string; reason_code: string }
  }
  function admit(db: OrchestrationDb, spawn: Partial<PtySpawnOptions> = {}) {
    return admitAgentLaunch(
      () => db,
      {
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        paneKey: PANE,
        command: `claude --resume ${X}`,
        ...spawn
      },
      { kind: 'caller' },
      {
        hostId: HOST_ID,
        executionHostId: HOST_ID,
        launchGeneration: 'gen-1',
        notice: () => {},
        contestedLineage: () => {},
        findConnectedPtyForPane: () => false,
        callerResume: null
      }
    )
  }

  it('a scoped miss is unrecorded resume_target_outside_pane_project: no row, spawn proceeds', async () => {
    const db = freshDb()
    hitsScoped()
    const admitted = await admit(db, { cwd: '/work/proj' })
    expect(admitted.spawnOptions.command).toBe(`claude --resume ${X}`)
    expect(scopedCalls()).toEqual([join(DEFAULT_ROOT, '-work-proj')])
    expect(db.newestLaunchForPane(HOST_ID, PANE)).toBeUndefined()
    expect(lastAudit(db)).toMatchObject({
      verb: 'launch_unrecorded',
      outcome: 'admitted',
      reason_code: 'resume_target_outside_pane_project'
    })
  })

  it('a scoped hit records the caller_resume row', async () => {
    const db = freshDb()
    hitsScoped(join(DEFAULT_ROOT, '-work-proj'))
    await admit(db, { cwd: '/work/proj' })
    expect(db.newestLaunchForPane(HOST_ID, PANE)).toMatchObject({
      session_id: X,
      evidence: 'caller_resume'
    })
  })

  it('CLAUDE_CONFIG_DIR in the spawn env changes the projects root', async () => {
    const db = freshDb()
    hitsScoped('/cfg/projects/-work-proj')
    await admit(db, { cwd: '/work/proj', env: { CLAUDE_CONFIG_DIR: '/cfg' } })
    expect(scopedCalls()).toEqual(['/cfg/projects/-work-proj'])
    expect(db.newestLaunchForPane(HOST_ID, PANE)?.evidence).toBe('caller_resume')
  })

  it('the NFC spelling of the cwd hits when the raw (NFD) one misses', async () => {
    const db = freshDb()
    const nfd = '/work/café'
    const composed = join(DEFAULT_ROOT, '-work-caf-')
    hitsScoped(composed)
    await admit(db, { cwd: nfd })
    expect(scopedCalls()).toEqual([join(DEFAULT_ROOT, '-work-cafe-'), composed])
    expect(db.newestLaunchForPane(HOST_ID, PANE)?.evidence).toBe('caller_resume')
  })

  it('no cwd: the check is skipped and the resume is recorded (fail-open, pinned)', async () => {
    const db = freshDb()
    hitsScoped()
    await admit(db)
    expect(scopedCalls()).toEqual([])
    expect(db.newestLaunchForPane(HOST_ID, PANE)?.evidence).toBe('caller_resume')
  })

  it('with a holder the check is not evaluated', async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-victim',
      agentType: 'claude',
      sessionId: X,
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    hitsScoped()
    await admit(db, { cwd: '/work/proj' })
    expect(scopedCalls()).toEqual([])
    expect(lastAudit(db).reason_code).toBe('resume_target_owned_by_pane_without_live_pty')
  })
})
