// S10-11 R2: thread membership succession from a tombstoned predecessor to a fresh successor.
import { describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import {
  adoptPredecessorThreadMembership,
  countUninheritedPredecessorMail
} from './agent-thread-succession'

function freshDb(): OrchestrationDb {
  return new OrchestrationDb(':memory:')
}

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function tombstone(
  db: Database.Database,
  id: string,
  hostId: string,
  displayName: string,
  quarantined = 0
): void {
  db.prepare(
    `INSERT INTO agents (id, display_name, host_id, state, derived, quarantined, origin_kind, origin_host_id, tombstoned_at)
     VALUES (?, ?, ?, 'gone', 0, ?, 'pane', ?, datetime('now'))`
  ).run(id, displayName, hostId, quarantined, hostId)
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

  // R2 fix: quarantine must survive retire — a quarantined predecessor's own thread membership
  // never transfers to whoever next reclaims its name.
  it("never transfers a quarantined predecessor's thread membership, even after it is retired", () => {
    const db = freshDb()
    const raw = rawDb(db)
    const { thread } = db.createThread({
      subject: 'credential rotation',
      createdByAgentId: 'agt_pred',
      sensitive: true,
      participants: [{ participantKey: 'agt_pred', agentId: 'agt_pred', role: 'owner' }]
    })
    tombstone(raw, 'agt_pred', 'local', 'agent-a', 1)

    const outcome = adoptPredecessorThreadMembership(raw, 'local', 'agent-a', 'agt_succ')
    expect(outcome.adoptedThreads).toBe(0)
    expect(db.isThreadParticipant(thread.id, 'agt_succ')).toBe(false)
    expect(db.isThreadParticipant(thread.id, 'agt_pred')).toBe(true)
    expect(raw.prepare('SELECT COUNT(*) AS n FROM agent_audit').get()).toEqual({ n: 0 })
    db.close()
  })

  // Defense-in-depth against laundering: a quarantined predecessor sharing a name blocks
  // adoption from EVERY predecessor under that name, not only its own membership.
  it('a quarantined predecessor blocks adoption from a different, non-quarantined predecessor sharing the same name', () => {
    const db = freshDb()
    const raw = rawDb(db)
    const { thread } = db.createThread({
      subject: 'ok thread',
      createdByAgentId: 'agt_pred_clean',
      participants: [{ participantKey: 'agt_pred_clean', agentId: 'agt_pred_clean', role: 'owner' }]
    })
    tombstone(raw, 'agt_pred_clean', 'local', 'agent-a', 0)
    tombstone(raw, 'agt_pred_quarantined', 'local', 'agent-a', 1)

    const outcome = adoptPredecessorThreadMembership(raw, 'local', 'agent-a', 'agt_succ')
    expect(outcome.adoptedThreads).toBe(0)
    expect(db.isThreadParticipant(thread.id, 'agt_succ')).toBe(false)
    expect(outcome.blockedByQuarantinedPredecessor).toBe(true)
    db.close()
  })

  it('a clean retire+register (nothing to inherit) is NOT reported as quarantine-blocked', () => {
    const db = freshDb()
    const raw = rawDb(db)
    const outcome = adoptPredecessorThreadMembership(raw, 'local', 'never-registered', 'agt_succ')
    expect(outcome.adoptedThreads).toBe(0)
    expect(outcome.blockedByQuarantinedPredecessor).toBe(false)
    db.close()
  })

  // F-9 (Ruling 32(b)): requirePactParticipant (pact-shared.ts) reads ONLY
  // threads.pact_proposer_agent_id/pact_with_agent_id/pact_turn_agent_id — never
  // thread_participants. Membership transfer alone left a pact predecessor was a party to
  // unreachable by the successor (still `not_a_participant` on every pact verb) even though
  // `orca agents threads` already listed the successor as a member — this is the "peers must
  // open fresh threads" field symptom. The pact columns must transfer too.
  it("transfers a pact predecessor's proposer/with/turn agent-id columns to the successor", () => {
    const db = freshDb()
    const raw = rawDb(db)
    const { thread } = db.createThread({
      subject: 'a pact thread',
      createdByAgentId: 'agt_pred',
      participants: [
        { participantKey: 'agt_pred', agentId: 'agt_pred', role: 'owner' },
        { participantKey: 'agt_peer', agentId: 'agt_peer', role: 'member' }
      ]
    })
    raw
      .prepare(
        `UPDATE threads SET pact_proposer_agent_id = ?, pact_with_agent_id = ?,
           pact_turn_agent_id = ?, pact_state = 'engaged' WHERE id = ?`
      )
      .run('agt_pred', 'agt_peer', 'agt_pred', thread.id)
    tombstone(raw, 'agt_pred', 'local', 'merge-backend')

    const outcome = adoptPredecessorThreadMembership(raw, 'local', 'merge-backend', 'agt_succ')
    expect(outcome.adoptedThreads).toBe(1)

    const row = raw
      .prepare(
        'SELECT pact_proposer_agent_id, pact_with_agent_id, pact_turn_agent_id FROM threads WHERE id = ?'
      )
      .get(thread.id) as {
      pact_proposer_agent_id: string
      pact_with_agent_id: string
      pact_turn_agent_id: string
    }
    expect(row.pact_proposer_agent_id).toBe('agt_succ')
    expect(row.pact_with_agent_id).toBe('agt_peer') // untouched: never the predecessor's column
    expect(row.pact_turn_agent_id).toBe('agt_succ')
    db.close()
  })

  it("a quarantined predecessor's pact columns never transfer either", () => {
    const db = freshDb()
    const raw = rawDb(db)
    const { thread } = db.createThread({
      subject: 'a pact thread',
      sensitive: true,
      createdByAgentId: 'agt_pred',
      participants: [{ participantKey: 'agt_pred', agentId: 'agt_pred', role: 'owner' }]
    })
    raw
      .prepare(
        `UPDATE threads SET pact_proposer_agent_id = ?, pact_turn_agent_id = ?,
           pact_state = 'engaged' WHERE id = ?`
      )
      .run('agt_pred', 'agt_pred', thread.id)
    tombstone(raw, 'agt_pred', 'local', 'agent-a', 1)

    adoptPredecessorThreadMembership(raw, 'local', 'agent-a', 'agt_succ')

    const row = raw
      .prepare('SELECT pact_proposer_agent_id, pact_turn_agent_id FROM threads WHERE id = ?')
      .get(thread.id) as { pact_proposer_agent_id: string; pact_turn_agent_id: string }
    expect(row.pact_proposer_agent_id).toBe('agt_pred')
    expect(row.pact_turn_agent_id).toBe('agt_pred')
    db.close()
  })

  // Ruling 32 Addendum 10 (A3/F-18): register-after-retire never repointed the predecessor's
  // durable `agent:<old id>` mailbox — unread mail addressed to it before the retire sat
  // unreadable forever (no read path resolves a tombstoned id).
  it('T-A6: repoints the tombstoned predecessor mailbox to the successor id, with an audit row', () => {
    const db = freshDb()
    const raw = rawDb(db)
    tombstone(raw, 'agt_pred', 'local', 'alpha')
    for (let i = 0; i < 3; i += 1) {
      db.insertGatedMessage({
        from: 'someone',
        to: 'agent:agt_pred',
        subject: `mail ${i}`,
        type: 'status',
        priority: 'normal'
      })
    }

    const outcome = adoptPredecessorThreadMembership(raw, 'local', 'alpha', 'agt_succ')
    expect(outcome.repointedMessages).toBe(3)

    const moved = raw
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE to_handle = 'agent:agt_succ'")
      .get() as { n: number }
    expect(moved.n).toBe(3)
    const stillOnOld = raw
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE to_handle = 'agent:agt_pred'")
      .get() as { n: number }
    expect(stillOnOld.n).toBe(0)

    const audit = raw
      .prepare(
        "SELECT outcome, reason_code FROM agent_audit WHERE verb = 'mailbox_repoint' AND agent_id = 'agt_succ'"
      )
      .get() as { outcome: string; reason_code: string } | undefined
    expect(audit?.outcome).toBe('ok')
    expect(audit?.reason_code).toContain('agent:agt_pred')
    db.close()
  })

  it('a quarantined predecessor blocks BOTH thread adoption and mailbox repoint', () => {
    const db = freshDb()
    const raw = rawDb(db)
    tombstone(raw, 'agt_pred', 'local', 'alpha', 1)
    db.insertGatedMessage({
      from: 'someone',
      to: 'agent:agt_pred',
      subject: 'locked mail',
      type: 'status',
      priority: 'normal'
    })

    const outcome = adoptPredecessorThreadMembership(raw, 'local', 'alpha', 'agt_succ')
    expect(outcome.blockedByQuarantinedPredecessor).toBe(true)
    expect(outcome.repointedMessages).toBe(0)
    const stillOnOld = raw
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE to_handle = 'agent:agt_pred'")
      .get() as { n: number }
    expect(stillOnOld.n).toBe(1)
    db.close()
  })
})

function insertPendingQuestion(raw: Database.Database, messageId: string, toAgentId: string): void {
  raw
    .prepare(
      `INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle, status, to_agent_id)
       VALUES (?, 'peer_questions', 'peer:t1', 'remote:env:asker', 'pending', ?)`
    )
    .run(messageId, toAgentId)
}

// F-9 honesty (Ruling 32 Addendum 9): question_threads.to_agent_id and unread bare-handle mail
// are deliberately never repointed onto a successor — this counts what was left behind so
// register can say so, instead of a bare "Inherited N thread(s)" reading as complete.
describe('countUninheritedPredecessorMail', () => {
  it('counts pending peer questions still addressed to the tombstoned predecessor', () => {
    const db = freshDb()
    const raw = rawDb(db)
    tombstone(raw, 'agt_pred', 'local', 'merge-backend')
    insertPendingQuestion(raw, 'q1', 'agt_pred')
    insertPendingQuestion(raw, 'q2', 'agt_pred')

    const outcome = countUninheritedPredecessorMail(raw, 'local', 'merge-backend', 'agt_succ')
    expect(outcome.pendingPeerQuestions).toBe(2)
    expect(outcome.unreadMailOnRetiredId).toBe(0)
    db.close()
  })

  it('does not count an already-answered or closed question', () => {
    const db = freshDb()
    const raw = rawDb(db)
    tombstone(raw, 'agt_pred', 'local', 'merge-backend')
    insertPendingQuestion(raw, 'q1', 'agt_pred')
    raw.prepare(`UPDATE question_threads SET status = 'answered' WHERE message_id = 'q1'`).run()

    const outcome = countUninheritedPredecessorMail(raw, 'local', 'merge-backend', 'agt_succ')
    expect(outcome.pendingPeerQuestions).toBe(0)
    db.close()
  })

  it('counts unread mail still addressed to the retired agent:<id> handle', () => {
    const db = freshDb()
    const raw = rawDb(db)
    tombstone(raw, 'agt_pred', 'local', 'merge-backend')
    db.insertGatedMessage({ from: 'agent:other', to: 'agent:agt_pred', subject: 'hi' })
    db.insertGatedMessage({ from: 'agent:other', to: 'agent:agt_pred', subject: 'hi again' })

    const outcome = countUninheritedPredecessorMail(raw, 'local', 'merge-backend', 'agt_succ')
    expect(outcome.unreadMailOnRetiredId).toBe(2)
    db.close()
  })

  it('does not count mail already read, or addressed to a different id', () => {
    const db = freshDb()
    const raw = rawDb(db)
    tombstone(raw, 'agt_pred', 'local', 'merge-backend')
    const inserted = db.insertGatedMessage({
      from: 'agent:other',
      to: 'agent:agt_pred',
      subject: 'hi'
    })
    if (inserted.outcome === 'stored') {
      raw.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(inserted.message.id)
    }
    db.insertGatedMessage({ from: 'agent:other', to: 'agent:someone_else', subject: 'hi' })

    const outcome = countUninheritedPredecessorMail(raw, 'local', 'merge-backend', 'agt_succ')
    expect(outcome.unreadMailOnRetiredId).toBe(0)
    db.close()
  })

  it('sums across every tombstoned predecessor sharing this host+name, quarantined or not', () => {
    const db = freshDb()
    const raw = rawDb(db)
    tombstone(raw, 'agt_pred_clean', 'local', 'agent-a', 0)
    tombstone(raw, 'agt_pred_quarantined', 'local', 'agent-a', 1)
    insertPendingQuestion(raw, 'q1', 'agt_pred_clean')
    insertPendingQuestion(raw, 'q2', 'agt_pred_quarantined')
    db.insertGatedMessage({ from: 'agent:other', to: 'agent:agt_pred_quarantined', subject: 'hi' })

    const outcome = countUninheritedPredecessorMail(raw, 'local', 'agent-a', 'agt_succ')
    expect(outcome.pendingPeerQuestions).toBe(2)
    expect(outcome.unreadMailOnRetiredId).toBe(1)
    db.close()
  })

  it('reports zero for a clean register with no tombstoned predecessor at all', () => {
    const db = freshDb()
    const raw = rawDb(db)
    const outcome = countUninheritedPredecessorMail(raw, 'local', 'never-registered', 'agt_succ')
    expect(outcome).toEqual({ pendingPeerQuestions: 0, unreadMailOnRetiredId: 0 })
    db.close()
  })
})
