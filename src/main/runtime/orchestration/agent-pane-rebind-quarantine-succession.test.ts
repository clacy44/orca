// F-3 (attacker-lens review, Ruling 33(a) H6a): remintRow's succession:true block must never
// adopt onto a QUARANTINED successor row — quarantine survives a rename/promote exactly the way
// it already survives a name-keyed predecessor scan (adoptPredecessorThreadMembership's own
// guard). Exercised through upsertAgentByPaneSuffix's own rename/promote fallback
// (agent-directory.ts:195, remintRow(existing, params, true)) — the same-pane, same-name plain
// register path every quarantined chair still uses.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { upsertAgentByPaneSuffix, type UpsertAgentByPaneSuffixParams } from './agent-directory'

describe('F-3 (Ruling 33(a) H6a): a quarantined successor never adopts on remintRow succession', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
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
      displayName: 'chair',
      role: null,
      hostId: 'local',
      paneKey: 'tab1:leaf-aaa',
      terminalHandle: 'term_a',
      processIncarnation: 'inc1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_a',
      originHostId: 'local',
      ...overrides
    }
  }

  it('a quarantined row re-registering (same pane, same name) adopts nothing, and the skip is audited', () => {
    const db = rawDb()

    // The holder registers FIRST, while 'chair' has no predecessor at all — its own 'created'
    // path adopts nothing (there is nothing yet to adopt), so nothing is inherited before the
    // quarantine below is ever in play.
    const holder = upsertAgentByPaneSuffix(db, baseParams())
    const holderId = holder.outcome === 'created' ? holder.agent.id : ''
    expect(holderId).not.toBe('')

    // A DIFFERENT tombstoned row under 'chair' — with thread membership — appears only now,
    // after the holder already exists. Only a later succession run could ever adopt it.
    const predecessorId = 'agt_pred_quarantine'
    db.prepare(
      `INSERT INTO agents (id, display_name, host_id, state, derived, quarantined, origin_kind, origin_host_id, tombstoned_at)
       VALUES (?, 'chair', 'local', 'gone', 0, 0, 'pane', 'local', datetime('now'))`
    ).run(predecessorId)
    const { thread } = orchestrationDb!.createThread({
      subject: 'plan',
      createdByAgentId: predecessorId,
      participants: [{ participantKey: predecessorId, agentId: predecessorId, role: 'owner' }]
    })

    db.prepare('UPDATE agents SET quarantined = 1 WHERE id = ?').run(holderId)

    // Same pane, same name — the rename/promote fallback's no-op refresh shape
    // (agent-directory.ts:195), succession:true, but the row itself is quarantined.
    const result = upsertAgentByPaneSuffix(db, baseParams())
    expect(result.outcome).toBe('reminted')
    if (result.outcome !== 'reminted') {
      throw new Error('fixture setup failed')
    }
    expect(result.adoptedThreads).toBe(0)
    expect(orchestrationDb!.isThreadParticipant(thread.id, holderId)).toBe(false)

    const skipAudit = db
      .prepare(
        `SELECT outcome, reason_code FROM agent_audit WHERE agent_id = ? AND verb = 'thread_succession_skipped' ORDER BY seq DESC LIMIT 1`
      )
      .get(holderId) as { outcome: string; reason_code: string } | undefined
    expect(skipAudit?.outcome).toBe('skipped')
    expect(skipAudit?.reason_code).toBe('succession_skipped_quarantined')

    const marker = db
      .prepare(`SELECT 1 FROM agent_audit WHERE agent_id = ? AND verb = 'thread_succession'`)
      .get(holderId)
    expect(marker).toBeUndefined()
  })
})
