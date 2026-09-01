// S10-11 R2: thread membership succession from a tombstoned predecessor to a fresh successor.
import { describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { adoptPredecessorThreadMembership } from './agent-thread-succession'

function freshDb(): OrchestrationDb {
  return new OrchestrationDb(':memory:')
}

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function tombstone(db: Database.Database, id: string, hostId: string, displayName: string): void {
  db.prepare(
    `INSERT INTO agents (id, display_name, host_id, state, derived, origin_kind, origin_host_id, tombstoned_at)
     VALUES (?, ?, ?, 'gone', 0, 'pane', ?, datetime('now'))`
  ).run(id, displayName, hostId, hostId)
}

describe('adoptPredecessorThreadMembership', () => {
  it("transfers a tombstoned predecessor's thread_participants row to the successor id", () => {
    const db = freshDb()
    const raw = rawDb(db)
    const { thread } = db.createThread({
      subject: 's',
      createdByAgentId: 'agt_pred',
      participants: [{ participantKey: 'agt_pred', agentId: 'agt_pred', role: 'owner' }]
    })
    tombstone(raw, 'agt_pred', 'local', 'merge-backend')

    const outcome = adoptPredecessorThreadMembership(raw, 'local', 'merge-backend', 'agt_succ')
    expect(outcome.adoptedThreads).toBe(1)

    const row = raw
      .prepare('SELECT participant_key, agent_id FROM thread_participants WHERE thread_id = ?')
      .get(thread.id) as { participant_key: string; agent_id: string }
    expect(row.participant_key).toBe('agt_succ')
    expect(row.agent_id).toBe('agt_succ')
    expect(db.isThreadParticipant(thread.id, 'agt_succ')).toBe(true)
    expect(db.isThreadParticipant(thread.id, 'agt_pred')).toBe(false)
    db.close()
  })

  it('is idempotent: a thread the successor already participates in is left alone, never double-claimed', () => {
    const db = freshDb()
    const raw = rawDb(db)
    const { thread } = db.createThread({
      subject: 's',
      createdByAgentId: 'agt_pred',
      participants: [
        { participantKey: 'agt_pred', agentId: 'agt_pred', role: 'owner' },
        { participantKey: 'agt_succ', agentId: 'agt_succ', role: 'member' }
      ]
    })
    tombstone(raw, 'agt_pred', 'local', 'merge-backend')

    const outcome = adoptPredecessorThreadMembership(raw, 'local', 'merge-backend', 'agt_succ')
    expect(outcome.adoptedThreads).toBe(0)

    // Both rows survive unmerged — the predecessor's own row is simply left behind, not deleted.
    const rows = raw
      .prepare(
        'SELECT participant_key FROM thread_participants WHERE thread_id = ? ORDER BY participant_key'
      )
      .all(thread.id) as { participant_key: string }[]
    expect(rows.map((r) => r.participant_key)).toEqual(['agt_pred', 'agt_succ'])
    db.close()
  })

  it('transfers across multiple tombstoned predecessors that shared the same name over time', () => {
    const db = freshDb()
    const raw = rawDb(db)
    const first = db.createThread({
      subject: 'thread one',
      createdByAgentId: 'agt_pred1',
      participants: [{ participantKey: 'agt_pred1', agentId: 'agt_pred1', role: 'owner' }]
    }).thread
    const second = db.createThread({
      subject: 'thread two',
      createdByAgentId: 'agt_pred2',
      participants: [{ participantKey: 'agt_pred2', agentId: 'agt_pred2', role: 'owner' }]
    }).thread
    tombstone(raw, 'agt_pred1', 'local', 'merge-backend')
    tombstone(raw, 'agt_pred2', 'local', 'merge-backend')

    const outcome = adoptPredecessorThreadMembership(raw, 'local', 'merge-backend', 'agt_succ')
    expect(outcome.adoptedThreads).toBe(2)
    expect(db.isThreadParticipant(first.id, 'agt_succ')).toBe(true)
    expect(db.isThreadParticipant(second.id, 'agt_succ')).toBe(true)
    db.close()
  })

  it('never transfers across hosts or names, and writes zero audit rows when nothing was adopted', () => {
    const db = freshDb()
    const raw = rawDb(db)
    db.createThread({
      subject: 's',
      createdByAgentId: 'agt_pred',
      participants: [{ participantKey: 'agt_pred', agentId: 'agt_pred', role: 'owner' }]
    })
    tombstone(raw, 'agt_pred', 'remote-host', 'merge-backend') // different host
    tombstone(raw, 'agt_other', 'local', 'unrelated-name') // different name

    const outcome = adoptPredecessorThreadMembership(raw, 'local', 'merge-backend', 'agt_succ')
    expect(outcome.adoptedThreads).toBe(0)
    expect(raw.prepare('SELECT COUNT(*) AS n FROM agent_audit').get()).toEqual({ n: 0 })
    db.close()
  })

  it('audits a real adoption with the agent_id and a human-readable reason', () => {
    const db = freshDb()
    const raw = rawDb(db)
    db.createThread({
      subject: 's',
      createdByAgentId: 'agt_pred',
      participants: [{ participantKey: 'agt_pred', agentId: 'agt_pred', role: 'owner' }]
    })
    tombstone(raw, 'agt_pred', 'local', 'merge-backend')

    adoptPredecessorThreadMembership(raw, 'local', 'merge-backend', 'agt_succ')

    const audit = raw
      .prepare(
        "SELECT agent_id, verb, outcome, reason_code FROM agent_audit WHERE verb = 'thread_succession'"
      )
      .get() as { agent_id: string; verb: string; outcome: string; reason_code: string }
    expect(audit.agent_id).toBe('agt_succ')
    expect(audit.outcome).toBe('ok')
    expect(audit.reason_code).toContain('1 thread(s)')
  })
})
