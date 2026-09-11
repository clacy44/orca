// S10-21d b6 (R119 fix 3): SELF_RESUME's own confirm/compensate — split out of
// agent-launch-admission.test.ts (near the 800-line test cap) per _common-rules.md's "split
// modules if needed and say so". Before this fix, SELF_RESUME's passThrough used the shared
// no-op confirm/compensate (agent-launch-admission-support.ts), so a spawn failure or a
// surface divergence after a SELF_RESUME admission left no trace at all.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { admitAgentLaunch, type LaunchAdmission } from './agent-launch-admission'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type { PtySpawnResult } from '../providers/pty-spawn-result'
import type * as NodeCrypto from 'node:crypto'

const MINTED_A = '11111111-1111-4111-8111-111111111111'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>()
  return { ...actual, randomUUID: vi.fn(() => MINTED_A) }
})

const CALLER: LaunchAdmission = { kind: 'caller' }
const HOST_ID = 'local'

describe('S10-21d b6, R119 fix 3: SELF_RESUME passThrough confirm/compensate', () => {
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

  function opts(overrides: Partial<PtySpawnOptions> = {}): PtySpawnOptions {
    return { cols: 80, rows: 24, launchAgent: 'claude', paneKey: 'tab1:leaf-a', ...overrides }
  }

  function ctx() {
    return {
      hostId: HOST_ID,
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      notice: () => {},
      contestedLineage: () => {},
      findConnectedPtyForPane: () => false
    }
  }

  async function selfResumeAdmit(db: OrchestrationDb) {
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'self-sess',
      launchGeneration: 'gen-1',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    return admitAgentLaunch(() => db, opts({ command: 'claude --resume self-sess' }), CALLER, ctx())
  }

  it('compensate() audits launch_spawn_failed for a SELF_RESUME admission (previously a silent no-op — SELF_RESUME writes no row, so there is nothing to delete)', async () => {
    const db = freshDb()
    const admitted = await selfResumeAdmit(db)
    admitted.compensate()
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; outcome: string }
    expect(auditRow.verb).toBe('launch_spawn_failed')
    expect(auditRow.outcome).toBe('compensated')
  })

  it('compensate() is idempotent and never fires after confirm() already settled', async () => {
    const db = freshDb()
    const admitted = await selfResumeAdmit(db)
    admitted.confirm({ id: 'pty-1' } as PtySpawnResult) // no agentSessionEnsure -> settles, no divergence
    admitted.compensate()
    const spawnFailedRows = rawDb(db)
      .prepare(`SELECT COUNT(*) as n FROM agent_audit WHERE verb = 'launch_spawn_failed'`)
      .get() as { n: number }
    expect(spawnFailedRows.n).toBe(0)
  })

  it('confirm() audits launch_surface_diverged for a SELF_RESUME admission when the spawn result names a different pane', async () => {
    const db = freshDb()
    const admitted = await selfResumeAdmit(db)
    const divergedResult: PtySpawnResult = {
      id: 'pty-1',
      agentSessionEnsure: {
        disposition: 'created',
        owner: {
          claim: {
            digestVersion: 1,
            keyId: 'k',
            identityDigest: 'd',
            worktreeScopeDigest: 'w',
            agent: 'claude'
          },
          generation: 'g',
          phase: 'live',
          ptyId: 'pty-1',
          surface: { worktreeId: 'wt', tabId: 'tab1', leafId: 'leaf-OTHER', terminalHandle: 'h' }
        }
      }
    }
    admitted.confirm(divergedResult)
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; outcome: string }
    expect(auditRow.verb).toBe('launch_surface_diverged')
    expect(auditRow.outcome).toBe('compensated')
  })
})
