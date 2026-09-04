// S10-21a C1 (§2.11 the N4 fix): retireAgent's UPDATE and the launch-table DELETE for that
// agent, in one explicit transaction. New file, additions only — agent-directory.test.ts
// already covers retireAgent's non-transactional behavior (tombstone, idempotency, agent_unknown).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { upsertAgentByPaneSuffix, type UpsertAgentByPaneSuffixParams } from './agent-directory'
import { launchBySessionId, recordLaunch } from './agent-launch-sessions'
import { retireAgent } from './agent-retire'
import { OrchestrationDb } from './db'

describe('S10-21a C1: retireAgent launch-row transaction', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    vi.restoreAllMocks()
    orchestrationDb?.close()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function baseParams(
    overrides: Partial<UpsertAgentByPaneSuffixParams> = {}
  ): UpsertAgentByPaneSuffixParams {
    return {
      displayName: 'merge-restructure-backend',
      role: 'backend for the merge restructure',
      hostId: 'local',
      paneKey: 'tab1:leaf-aaa',
      terminalHandle: 'term_a',
      processIncarnation: 'inc1',
      worktreeId: 'wt1',
      worktreePath: '/wt/merge-restructure',
      branch: 'merge-restructure',
      title: 'sanitized title',
      agentLabel: 'Claude Code',
      originHandle: 'term_a',
      originHostId: 'local',
      ...overrides
    }
  }

  it('deletes the agent_id-linked launch rows in the same transaction as the tombstone', () => {
    const db = rawDb()
    const created = upsertAgentByPaneSuffix(db, baseParams())
    const id = created.outcome === 'created' ? created.agent.id : ''

    const launch = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-aaa',
      agentType: 'claude',
      sessionId: 'sess-1',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    expect(launch.ok).toBe(true)
    if (launch.ok) {
      db.prepare('UPDATE agent_launch_sessions SET agent_id = ? WHERE seq = ?').run(
        id,
        launch.row.seq
      )
    }

    const result = retireAgent(db, id)
    expect(result.outcome).toBe('retired')

    const remaining = db
      .prepare('SELECT COUNT(*) AS c FROM agent_launch_sessions WHERE agent_id = ?')
      .get(id) as { c: number }
    expect(remaining.c).toBe(0)
  })

  it('a throw injected after the tombstone UPDATE leaves both the agent row and the launch row untouched', () => {
    const db = rawDb()
    const created = upsertAgentByPaneSuffix(db, baseParams())
    const id = created.outcome === 'created' ? created.agent.id : ''

    const launch = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-aaa',
      agentType: 'claude',
      sessionId: 'sess-2',
      launchGeneration: 'gen-2',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    expect(launch.ok).toBe(true)
    if (launch.ok) {
      db.prepare('UPDATE agent_launch_sessions SET agent_id = ? WHERE seq = ?').run(
        id,
        launch.row.seq
      )
    }

    const prepare = db.prepare.bind(db)
    let injected = false
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = prepare(sql)
      if (!injected && sql.includes('UPDATE agents SET tombstoned_at')) {
        injected = true
        const originalRun = stmt.run.bind(stmt)
        // Mutate the statement in place (not a spread copy — node:sqlite's StatementSync
        // exposes .run/.get/.all via the prototype, so `{...stmt}` silently drops them).
        stmt.run = ((...args: unknown[]) => {
          originalRun(...(args as never[]))
          throw new Error('injected failure after tombstone UPDATE')
        }) as typeof stmt.run
      }
      return stmt
    })

    expect(() => retireAgent(db, id)).toThrow(/injected failure/)
    expect(injected).toBe(true)
    vi.restoreAllMocks()

    const agentRow = db.prepare('SELECT tombstoned_at FROM agents WHERE id = ?').get(id) as {
      tombstoned_at: string | null
    }
    expect(agentRow.tombstoned_at).toBeNull()

    const stillPresent = launchBySessionId(db, 'sess-2')
    expect(stillPresent).toBeDefined()
    expect(stillPresent?.agent_id).toBe(id)
  })

  it("[S10-21a C1a, errata 5(p)-5 §F item 6] deletes the retired agent's current_sessions row in the same transaction as the tombstone", () => {
    const db = rawDb()
    const created = upsertAgentByPaneSuffix(db, baseParams())
    const id = created.outcome === 'created' ? created.agent.id : ''

    const launch = recordLaunch(db, {
      hostId: 'local',
      paneKey: 'tab1:leaf-aaa',
      agentType: 'claude',
      sessionId: 'sess-3',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    expect(launch.ok).toBe(true)
    if (launch.ok) {
      db.prepare('UPDATE agent_launch_sessions SET agent_id = ? WHERE seq = ?').run(
        id,
        launch.row.seq
      )
    }
    expect(
      db
        .prepare('SELECT 1 FROM current_sessions WHERE host_id = ? AND pane_key = ?')
        .get('local', 'tab1:leaf-aaa')
    ).toBeDefined()

    const result = retireAgent(db, id)
    expect(result.outcome).toBe('retired')

    expect(
      db
        .prepare('SELECT 1 FROM current_sessions WHERE host_id = ? AND pane_key = ?')
        .get('local', 'tab1:leaf-aaa')
    ).toBeUndefined()
  })
})
