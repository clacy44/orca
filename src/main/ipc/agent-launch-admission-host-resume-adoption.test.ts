// S10-21d b3c (D-R163 M3 negatives 3/4): split out of agent-launch-admission.test.ts to stay
// under the max-lines test budget (800) — mirrors agent-launch-admission-host-resume-race.test.ts's
// own split for the same reason. Covers the HOST_RESUME arm's null-predecessor SUCCESS shape
// (DEC-2's own "unheld restore" case, undertested: only its foreign-collision refusal had a test
// before this brief) and the dead-holder evidence's ('host_restore', predecessor set) own
// compensate path.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { admitAgentLaunch, type LaunchAdmission } from './agent-launch-admission'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type * as NodeCrypto from 'node:crypto'

const MINTED_A = '11111111-1111-4111-8111-111111111111'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>()
  return { ...actual, randomUUID: vi.fn(() => MINTED_A) }
})

vi.mock('../startup/resolve-resume-transcript', () => ({
  resolveResumeTranscript: vi.fn(async () => ({ path: '/fake/transcript.jsonl', hasTurn: true }))
}))

const HOST_ID = 'local'

describe('D-R163 M3 negatives 3/4: HOST_RESUME null-predecessor success, and host_restore compensate', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
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
      ...overrides
    }
  }

  function opts(overrides: Partial<PtySpawnOptions> = {}): PtySpawnOptions {
    return { cols: 80, rows: 24, launchAgent: 'claude', paneKey: 'tab1:leaf-a', ...overrides }
  }

  it('negative 3: a null-predecessor (unheld) host_restore whose session id is held by NOBODY records exactly one row, no supersede, no current_sessions touched anywhere else', async () => {
    const db = freshDb()
    const admission: LaunchAdmission = {
      kind: 'host-resume',
      sessionId: 'unheld-sess',
      predecessorPaneKey: null,
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      evidence: 'host_restore'
    }
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume unheld-sess' }),
      admission,
      ctx()
    )
    expect(admitted.spawnOptions.command).toBe('claude --resume unheld-sess')
    const row = db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')
    expect(row?.session_id).toBe('unheld-sess')
    expect(row?.evidence).toBe('host_restore')
    const rowCount = rawDb(db)
      .prepare('SELECT COUNT(*) as n FROM agent_launch_sessions WHERE session_id = ?')
      .get('unheld-sess') as { n: number }
    expect(rowCount.n).toBe(1)
    // No supersede: exactly one current_sessions row exists for this session, naming this pane —
    // never a second pane's row deleted (there was none to delete).
    const currentSessionRows = rawDb(db)
      .prepare('SELECT pane_key FROM current_sessions WHERE host_id = ? AND session_id = ?')
      .all(HOST_ID, 'unheld-sess') as { pane_key: string }[]
    expect(currentSessionRows).toEqual([{ pane_key: 'tab1:leaf-a' }])
  })

  // [S10-21d C3] This proves `admitAgentLaunch`'s OWN write is correct given a `ctx` that
  // already carries `launchPreferences` — it injects `ctx.launchPreferences` directly (below),
  // so it does NOT cover the seam upstream of admission: `chair-restore.ts`'s/the restart
  // sweep's `ensureAgentSession` request -> `createTerminal`'s `opts.launchPreferences` ->
  // `RuntimePtyController#spawn` -> `launchAdmissionBundle` -> this same `ctx.launchPreferences`
  // (`resolveHostResumeRecordLaunch`, agent-launch-admission-host-resume.ts). That upstream
  // wiring — the seam the Gate-3 defect actually lived in — is covered by
  // `ensure-agent-session-host-resume-prefs-chained.test.ts` (src/main/runtime), which drives
  // the real chain end to end instead of hand-building `ctx`.
  it('[S10-21d bD C2, D-R168 LOW-1] a host_restore admission naming a model and an effort writes pref_model/pref_effort with pref_source "launch" on the new launch row', async () => {
    const db = freshDb()
    const admission: LaunchAdmission = {
      kind: 'host-resume',
      sessionId: 'sess-with-prefs',
      predecessorPaneKey: null,
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      evidence: 'host_restore'
    }
    await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume sess-with-prefs' }),
      admission,
      ctx({ launchPreferences: { model: 'opus', effort: 'high' } })
    )
    const row = db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')
    expect(row?.pref_model).toBe('opus')
    expect(row?.pref_effort).toBe('high')
    expect(row?.pref_source).toBe('launch')
  })

  it('negative 4: a dead-holder adoption (host_restore, predecessor set) whose spawn THROWS is compensated — the row it wrote is deleted, the predecessor pane current_sessions row is restored, DB is back to its prior state', async () => {
    const db = freshDb()
    // The dead holder's own prior launch history — what the compensate path must restore.
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-dead-holder',
      agentType: 'claude',
      sessionId: 'sess-adopted',
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    const priorState = rawDb(db)
      .prepare('SELECT * FROM current_sessions WHERE host_id = ? AND session_id = ?')
      .get(HOST_ID, 'sess-adopted')
    const admission: LaunchAdmission = {
      kind: 'host-resume',
      sessionId: 'sess-adopted',
      predecessorPaneKey: 'tab1:leaf-dead-holder',
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      evidence: 'host_restore'
    }
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume sess-adopted' }),
      admission,
      ctx()
    )
    // The adopting write already happened: predecessor's current_sessions row is GONE, the new
    // pane's row names the adopted session.
    expect(
      rawDb(db)
        .prepare('SELECT 1 FROM current_sessions WHERE host_id = ? AND pane_key = ?')
        .get(HOST_ID, 'tab1:leaf-dead-holder')
    ).toBeUndefined()
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')?.session_id).toBe('sess-adopted')

    admitted.compensate() // simulates provider.spawn throwing after admission

    // The row this call wrote is gone.
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    // The predecessor's current_sessions row is restored — DB back to its prior state for it.
    const restored = rawDb(db)
      .prepare('SELECT * FROM current_sessions WHERE host_id = ? AND session_id = ?')
      .get(HOST_ID, 'sess-adopted')
    expect(restored).toEqual(priorState)
    // The dead holder's OWN launch row (agent_launch_sessions) was never touched by either the
    // adopt or the compensate — only current_sessions moves.
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-dead-holder')?.session_id).toBe(
      'sess-adopted'
    )
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string }
    expect(auditRow.verb).toBe('launch_spawn_failed')
  })
})
