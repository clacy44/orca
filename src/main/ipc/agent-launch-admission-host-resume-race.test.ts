// S10-21d b3b (D-R163 H1/H2 LOW): split out of agent-launch-admission.test.ts to stay under the
// max-lines test budget (800). Covers `checkHostResumeHolderUnmoved` (agent-launch-admission-
// host-resume.ts) — the HOST_RESUME arm's fresh, inside-the-lock re-read of predecessor pane
// holding + generation, closing the D-R163 H1 race (a holder relaunch between requestChairRestore's
// predicate and this admission's lock would otherwise let the unconditional supersede delete a
// LIVE pane's binding) — plus the H2 LOW null-predecessor foreign_session_id surfacing fix.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import {
  admitAgentLaunch,
  LaunchAdmissionRefusedError,
  type LaunchAdmission
} from './agent-launch-admission'
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

describe('D-R163 H1/H2 LOW: checkHostResumeHolderUnmoved (the pane-lock re-check)', () => {
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

  it('a launcher restore (host_restore) whose holder relaunched under the CURRENT generation between the predicate and this lock is refused, no delete, no write', async () => {
    const db = freshDb()
    // Simulates the holder having relaunched (a fresh launch row under the CURRENT generation)
    // after the predicate ran but before this admission took its lock.
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-old',
      agentType: 'claude',
      sessionId: 'predecessor-sess',
      launchGeneration: 'gen-1',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    const admission: LaunchAdmission = {
      kind: 'host-resume',
      sessionId: 'predecessor-sess',
      predecessorPaneKey: 'tab1:leaf-old',
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      evidence: 'host_restore'
    }
    await expect(
      admitAgentLaunch(
        () => db,
        opts({ command: 'claude --resume predecessor-sess' }),
        admission,
        ctx()
      )
    ).rejects.toThrow(LaunchAdmissionRefusedError)
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    // No delete of the (still-live) holder's current_sessions row.
    expect(
      rawDb(db)
        .prepare('SELECT 1 FROM current_sessions WHERE host_id = ? AND pane_key = ?')
        .get(HOST_ID, 'tab1:leaf-old')
    ).toBeDefined()
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_refused')
    expect(auditRow.reason_code).toBe('restore_holder_current_generation')
  })

  it('a launcher restore (host_restore) whose holder pane moved between the predicate and this lock is refused, no delete, no write', async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-old',
      agentType: 'claude',
      sessionId: 'predecessor-sess',
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    // Simulates the session moving to a DIFFERENT pane after the predicate ran.
    rawDb(db)
      .prepare('UPDATE current_sessions SET pane_key = ? WHERE host_id = ? AND session_id = ?')
      .run('tab1:leaf-elsewhere', HOST_ID, 'predecessor-sess')
    const admission: LaunchAdmission = {
      kind: 'host-resume',
      sessionId: 'predecessor-sess',
      predecessorPaneKey: 'tab1:leaf-old',
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      evidence: 'host_restore'
    }
    await expect(
      admitAgentLaunch(
        () => db,
        opts({ command: 'claude --resume predecessor-sess' }),
        admission,
        ctx()
      )
    ).rejects.toThrow(LaunchAdmissionRefusedError)
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    expect(
      rawDb(db)
        .prepare('SELECT pane_key FROM current_sessions WHERE host_id = ? AND session_id = ?')
        .get(HOST_ID, 'predecessor-sess')
    ).toEqual({ pane_key: 'tab1:leaf-elsewhere' })
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_refused')
    expect(auditRow.reason_code).toBe('restore_holder_moved')
  })

  it('an UNCHANGED launcher restore (host_restore, holder still on its prior generation, still the recorded pane) is adopted', async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-old',
      agentType: 'claude',
      sessionId: 'predecessor-sess',
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    const admission: LaunchAdmission = {
      kind: 'host-resume',
      sessionId: 'predecessor-sess',
      predecessorPaneKey: 'tab1:leaf-old',
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      evidence: 'host_restore'
    }
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume predecessor-sess' }),
      admission,
      ctx()
    )
    expect(admitted.spawnOptions.command).toBe('claude --resume predecessor-sess')
    const row = db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')
    expect(row?.session_id).toBe('predecessor-sess')
    expect(row?.evidence).toBe('host_restore')
    expect(
      rawDb(db)
        .prepare('SELECT 1 FROM current_sessions WHERE host_id = ? AND pane_key = ?')
        .get(HOST_ID, 'tab1:leaf-old')
    ).toBeUndefined()
  })

  it('the null-predecessor (launcher unheld restore) arm surfaces foreign_session_id, not launch_record_write_failed', async () => {
    const db = freshDb()
    // A different pane already holds this session id.
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-other',
      agentType: 'claude',
      sessionId: 'predecessor-sess',
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    const admission: LaunchAdmission = {
      kind: 'host-resume',
      sessionId: 'predecessor-sess',
      predecessorPaneKey: null,
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      evidence: 'host_restore'
    }
    await expect(
      admitAgentLaunch(
        () => db,
        opts({ command: 'claude --resume predecessor-sess' }),
        admission,
        ctx()
      )
    ).rejects.toThrow(LaunchAdmissionRefusedError)
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_refused')
    expect(auditRow.reason_code).toBe('foreign_session_id')
  })
})
