// S10-2a threads/thread_participants CRUD — DB-level tests through the public OrchestrationDb
// API. Mutation-guard comments match the s10-2-spec.md TESTS table format.
import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

function freshDb(): OrchestrationDb {
  return new OrchestrationDb(':memory:')
}

describe('createThread / getThread / participants', () => {
  it('creates a thread with its participants and returns both', () => {
    const db = freshDb()
    const { thread, participants } = db.createThread({
      subject: 'merge restructure',
      createdByAgentId: null,
      participants: [
        { participantKey: 'agent:a', handle: 'a' },
        { participantKey: 'agent:b', handle: 'b' }
      ]
    })
    expect(thread.subject).toBe('merge restructure')
    expect(thread.origin).toBe('peer')
    expect(thread.state).toBe('open')
    expect(participants.map((p) => p.participant_key).sort()).toEqual(['agent:a', 'agent:b'])
    expect(db.getThread(thread.id)?.id).toBe(thread.id)
    expect(db.isThreadParticipant(thread.id, 'agent:a')).toBe(true)
    expect(db.isThreadParticipant(thread.id, 'agent:c')).toBe(false)
    db.close()
  })

  it('trigger: thread provenance (id/created_at/created_by_agent_id/origin) is immutable', () => {
    const db = freshDb()
    const { thread } = db.createThread({
      subject: 's',
      createdByAgentId: 'agt_a',
      origin: 'peer',
      participants: []
    })
    const raw = rawDb(db)
    expect(() =>
      raw.prepare("UPDATE threads SET origin = 'legacy' WHERE id = ?").run(thread.id)
    ).toThrow(/provenance is immutable/)
    // Non-provenance fields (state, subject) are NOT protected by this trigger.
    expect(() =>
      raw.prepare("UPDATE threads SET state = 'closed' WHERE id = ?").run(thread.id)
    ).not.toThrow()
    db.close()
  })

  it('trigger mutation guard: sensitive can latch 0->1 but never unlatch 1->0', () => {
    const db = freshDb()
    const { thread } = db.createThread({
      subject: 's',
      createdByAgentId: null,
      sensitive: true,
      participants: []
    })
    const raw = rawDb(db)
    expect(() =>
      raw.prepare('UPDATE threads SET sensitive = 0 WHERE id = ?').run(thread.id)
    ).toThrow(/provenance is immutable/)
    db.close()
  })
})

describe('listThreadsForParticipant', () => {
  it("scopes to the caller's own live participations, newest last-message first", () => {
    const db = freshDb()
    const a = db.createThread({
      subject: 'one',
      createdByAgentId: null,
      participants: [{ participantKey: 'agent:a' }]
    })
    const b = db.createThread({
      subject: 'two',
      createdByAgentId: null,
      participants: [{ participantKey: 'agent:a' }]
    })
    db.createThread({
      subject: 'not mine',
      createdByAgentId: null,
      participants: [{ participantKey: 'agent:z' }]
    })
    db.bumpThreadOnMessage(a.thread.id, {
      id: 'm1',
      sequence: 1,
      created_at: '2026-08-30 12:00:00'
    })
    db.bumpThreadOnMessage(b.thread.id, {
      id: 'm2',
      sequence: 2,
      created_at: '2026-08-30 12:00:01'
    })
    const list = db.listThreadsForParticipant({ participantKey: 'agent:a' })
    expect(list.map((t) => t.id)).toEqual([b.thread.id, a.thread.id])
    db.close()
  })

  it('leaveThread removes the participant from the live list but keeps history', () => {
    const db = freshDb()
    const { thread } = db.createThread({
      subject: 's',
      createdByAgentId: null,
      participants: [{ participantKey: 'agent:a' }]
    })
    db.leaveThread(thread.id, 'agent:a')
    expect(db.listThreadsForParticipant({ participantKey: 'agent:a' })).toHaveLength(0)
    expect(db.isThreadParticipant(thread.id, 'agent:a')).toBe(false)
    const raw = rawDb(db)
    const row = raw
      .prepare(
        'SELECT left_at FROM thread_participants WHERE thread_id = ? AND participant_key = ?'
      )
      .get(thread.id, 'agent:a') as { left_at: string | null }
    expect(row.left_at).not.toBeNull()
    db.close()
  })
})

describe('setThreadState / setThreadPact / markThreadRead', () => {
  it('setThreadState updates state', () => {
    const db = freshDb()
    const { thread } = db.createThread({ subject: 's', createdByAgentId: null, participants: [] })
    const updated = db.setThreadState(thread.id, 'closed')
    expect(updated.state).toBe('closed')
    db.close()
  })

  it('setThreadPact writes pact columns', () => {
    const db = freshDb()
    const { thread } = db.createThread({ subject: 's', createdByAgentId: null, participants: [] })
    const updated = db.setThreadPact(thread.id, {
      pactWithAgentId: 'agt_b',
      pactState: 'engaged',
      pactTurnAgentId: 'agt_a'
    })
    expect(updated.pact_state).toBe('engaged')
    expect(updated.pact_turn_agent_id).toBe('agt_a')
    db.close()
  })

  it('T14: markThreadRead only ever writes last_read_sequence, never messages.delivered_at (S10-1 ruling B2)', () => {
    const db = freshDb()
    const { thread } = db.createThread({
      subject: 's',
      createdByAgentId: null,
      participants: [{ participantKey: 'agent:a' }]
    })
    const sent = db.insertGatedMessage({
      from: 'agent:b',
      to: 'agent:a',
      subject: 'x',
      body: 'x',
      threadId: thread.id,
      runId: 'run_peer_local',
      verb: 'send'
    })
    if (sent.outcome !== 'stored') {
      throw new Error('expected stored')
    }
    db.markThreadRead(thread.id, 'agent:a', sent.message.sequence)
    const raw = rawDb(db)
    const cursor = raw
      .prepare(
        'SELECT last_read_sequence FROM thread_participants WHERE thread_id = ? AND participant_key = ?'
      )
      .get(thread.id, 'agent:a') as { last_read_sequence: number }
    expect(cursor.last_read_sequence).toBe(sent.message.sequence)
    const message = raw
      .prepare('SELECT delivered_at FROM messages WHERE id = ?')
      .get(sent.message.id) as {
      delivered_at: string | null
    }
    expect(message.delivered_at).toBeNull()
    db.close()
  })

  it('T14 mutation guard: the cursor never regresses past a later read', () => {
    const db = freshDb()
    const { thread } = db.createThread({
      subject: 's',
      createdByAgentId: null,
      participants: [{ participantKey: 'agent:a' }]
    })
    db.markThreadRead(thread.id, 'agent:a', 5)
    db.markThreadRead(thread.id, 'agent:a', 2)
    const raw = rawDb(db)
    const cursor = raw
      .prepare(
        'SELECT last_read_sequence FROM thread_participants WHERE thread_id = ? AND participant_key = ?'
      )
      .get(thread.id, 'agent:a') as { last_read_sequence: number }
    expect(cursor.last_read_sequence).toBe(5)
    db.close()
  })
})

describe('getThreadMessagesSince — purge and quarantine filtering', () => {
  it('a purged thread cannot be re-poisoned through the same thread id: a message posted after purgeThread is filtered out of replay and counted in omitted.purged', () => {
    // Mutation this kills: filtering only messages.purged_at and never joining threads.purged_at
    // — purgeThread correctly tombstones the thread row (getThread -> undefined) but a message
    // inserted straight into that thread id afterward would otherwise be served in full.
    const db = freshDb()
    const { thread } = db.createThread({ subject: 's', createdByAgentId: null, participants: [] })
    insert(db, thread.id, 'poison one')
    const purgeResult = db.purgeThread({
      threadId: thread.id,
      reason: 'containment',
      purgedByAgentId: null
    })
    expect(purgeResult).toMatchObject({ outcome: 'purged', purgedCount: 1 })
    expect(db.getThread(thread.id)).toBeUndefined()

    // insert() throws unless the write is stored — a purged thread id still accepts the write
    // today (that send-side refusal is S10-2b's), but the READ below must not serve it.
    insert(db, thread.id, 'poison two, posted after the thread purge')

    const { messages, omitted } = db.getThreadMessagesSince(thread.id, undefined)
    expect(messages).toHaveLength(0)
    expect(omitted.purged).toBeGreaterThan(0)
    db.close()
  })

  it('T6: a purged message is absent from replay and counted in omitted.purged', () => {
    const db = freshDb()
    const { thread } = db.createThread({ subject: 's', createdByAgentId: null, participants: [] })
    const m1 = insert(db, thread.id, 'one')
    const m2 = insert(db, thread.id, 'two')
    db.purgeMessage({ messageId: m1.id, reason: 'x', purgedByAgentId: null })
    const { messages, omitted } = db.getThreadMessagesSince(thread.id, undefined)
    expect(messages.map((m) => m.id)).toEqual([m2.id])
    expect(omitted.purged).toBe(1)
    db.close()
  })

  it("T8: a quarantined author's messages are withheld from replay and counted in omitted.withheld; listMessagesByAuthor (the operator surface) still returns them", () => {
    const db = freshDb()
    db.upsertAgentByPaneSuffix({
      displayName: 'backend-merge',
      role: null,
      hostId: 'local',
      paneKey: 'tab1:leaf1',
      terminalHandle: 'backend-merge',
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'backend-merge',
      originHostId: 'local'
    })
    const agentId = db.getAgentByPaneKey('local', 'tab1:leaf1')?.id as string
    const { thread } = db.createThread({ subject: 's', createdByAgentId: null, participants: [] })
    const message = db.insertGatedMessage({
      from: 'backend-merge',
      to: 'agent:a',
      subject: 'x',
      body: 'x',
      threadId: thread.id,
      runId: 'run_peer_local',
      verb: 'send',
      senderPaneKey: 'tab1:leaf1',
      senderHostId: 'local'
    })
    if (message.outcome !== 'stored') {
      throw new Error('expected stored')
    }
    db.setAgentQuarantine({ id: agentId, quarantined: true, reasonCode: 'containment' })

    const { messages, omitted } = db.getThreadMessagesSince(thread.id, undefined)
    expect(messages).toHaveLength(0)
    expect(omitted.withheld).toBe(1)
    const authored = db.listMessagesByAuthor({ senderAgentId: agentId })
    expect(authored.map((m) => m.id)).toContain(message.message.id)
    db.close()
  })

  it('T8 mutation guard: withholding is asserted on a non-zero count, not vacuously on zero rows', () => {
    // If sender_agent_id were left unwritten (the ruling-7 regression), the quarantine join
    // would match zero rows and this assertion — omitted.withheld > 0 — would fail loudly
    // instead of the suite passing vacuously on an always-empty filter.
    const db = freshDb()
    db.upsertAgentByPaneSuffix({
      displayName: 'backend-merge',
      role: null,
      hostId: 'local',
      paneKey: 'tab1:leaf1',
      terminalHandle: 'backend-merge',
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'backend-merge',
      originHostId: 'local'
    })
    const agentId = db.getAgentByPaneKey('local', 'tab1:leaf1')?.id as string
    const { thread } = db.createThread({ subject: 's', createdByAgentId: null, participants: [] })
    db.insertGatedMessage({
      from: 'backend-merge',
      to: 'agent:a',
      subject: 'x',
      body: 'x',
      threadId: thread.id,
      runId: 'run_peer_local',
      verb: 'send',
      senderPaneKey: 'tab1:leaf1',
      senderHostId: 'local'
    })
    db.setAgentQuarantine({ id: agentId, quarantined: true, reasonCode: 'containment' })
    const { omitted } = db.getThreadMessagesSince(thread.id, undefined)
    expect(omitted.withheld).toBeGreaterThan(0)
    db.close()
  })
})

function insert(db: OrchestrationDb, threadId: string, body: string) {
  const result = db.insertGatedMessage({
    from: 'agent:a',
    to: 'agent:b',
    subject: body,
    body,
    threadId,
    runId: 'run_peer_local',
    verb: 'send'
  })
  if (result.outcome !== 'stored') {
    throw new Error(`expected stored, got ${result.outcome}`)
  }
  return result.message
}

function rawDb(db: OrchestrationDb): {
  prepare: (s: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown }
} {
  return (db as unknown as { db: ReturnType<typeof rawDb> }).db
}
