// S10-21c B-final F5 (D-R159 finding 5): HOST_MINTED and caller_resume superseding a DERIVED
// registered row's session now write a distinct 'launch_recorded'/'derived_row_superseded' audit
// row instead of a traceless write — split out of agent-launch-admission.test.ts (near the
// 800-line test cap) per _common-rules.md's "split modules if needed and say so".
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

describe('S10-21c B-final F5, D-R159 finding 5: derived registered row supersession audit', () => {
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

  // A DERIVED registered row (an ordinary terminal's own agent row) — origin_kind CHECK requires
  // 'derived' whenever derived=1.
  function insertDerivedRegisteredAgent(db: OrchestrationDb, paneKey: string): void {
    rawDb(db)
      .prepare(
        `INSERT INTO agents (
           id, display_name, host_id, pane_key, derived, origin_kind, origin_pane_key,
           origin_host_id
         ) VALUES (?, ?, ?, ?, 1, 'derived', ?, ?)`
      )
      .run(`agt_${paneKey}`, `disp-${paneKey}`, HOST_ID, paneKey, paneKey, HOST_ID)
  }

  function auditRows(
    db: OrchestrationDb,
    paneKey: string,
    verb: string
  ): { outcome: string; reason_code: string | null }[] {
    return rawDb(db)
      .prepare(`SELECT outcome, reason_code FROM agent_audit WHERE actor_pane_key = ? AND verb = ?`)
      .all(paneKey, verb) as { outcome: string; reason_code: string | null }[]
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

  it("a covered, selector-free launch naming a pane with a DERIVED registered row is HOST_MINTED and writes a distinct 'launch_recorded'/'derived_row_superseded' audit row, never contestedLineage", async () => {
    const db = freshDb()
    insertDerivedRegisteredAgent(db, 'tab1:leaf-a')
    const contested: [string, string, string][] = []
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude' }),
      CALLER,
      ctx({
        contestedLineage: (claimantPaneKey, registeredPaneKey, registeredAgentId) =>
          contested.push([claimantPaneKey, registeredPaneKey, registeredAgentId])
      })
    )
    expect(admitted.spawnOptions.command).toBe(`claude --session-id '${MINTED_A}'`)
    expect(contested).toEqual([])
    const rows = auditRows(db, 'tab1:leaf-a', 'launch_recorded')
    expect(rows).toEqual([{ outcome: 'admitted', reason_code: 'derived_row_superseded' }])
  })

  it("a caller's `claude --resume X` into a DERIVED registered pane's own relaunch writes a distinct 'launch_recorded'/'derived_row_superseded' audit row, never contestedLineage", async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'first-sess',
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    insertDerivedRegisteredAgent(db, 'tab1:leaf-a')
    const contested: [string, string, string][] = []
    await admitAgentLaunch(
      () => db,
      opts({ command: `claude --resume ${REAL_CONVERSATION_ID}` }),
      CALLER,
      ctx({
        contestedLineage: (claimantPaneKey, registeredPaneKey, registeredAgentId) =>
          contested.push([claimantPaneKey, registeredPaneKey, registeredAgentId])
      })
    )
    expect(contested).toEqual([])
    const rows = auditRows(db, 'tab1:leaf-a', 'launch_recorded')
    expect(rows).toEqual([{ outcome: 'admitted', reason_code: 'derived_row_superseded' }])
  })
})
