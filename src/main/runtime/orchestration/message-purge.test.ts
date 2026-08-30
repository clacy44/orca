// S10-2a purgeMessage/purgeThread/listMessagesByAuthor — DB-level tests through the public
// OrchestrationDb API. Mutation-guard comments match the s10-2-spec.md TESTS table format.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

function freshDb(): OrchestrationDb {
  return new OrchestrationDb(':memory:')
}

function send(
  db: OrchestrationDb,
  overrides: Partial<Parameters<OrchestrationDb['insertGatedMessage']>[0]> = {}
) {
  const result = db.insertGatedMessage({
    from: 'agent:a',
    to: 'agent:b',
    subject: 'hello',
    body: 'hello world',
    runId: 'run_peer_local',
    verb: 'send',
    ...overrides
  })
  if (result.outcome !== 'stored') {
    throw new Error(`expected stored, got ${result.outcome}`)
  }
  return result.message
}

describe('purgeMessage', () => {
  it('T6: tombstones body/subject/payload, keeps provenance and reason', () => {
    const db = freshDb()
    const message = send(db, { payload: { note: 'secret' } })
    const result = db.purgeMessage({
      messageId: message.id,
      reason: 'sent to the wrong recipient',
      purgedByAgentId: 'agt_operator'
    })
    expect(result.outcome).toBe('purged')
    if (result.outcome !== 'purged') {
      throw new Error('expected purged')
    }
    expect(result.message.body).toBe('')
    expect(result.message.subject).toBe('[purged]')
    expect(result.message.payload).toBeNull()
    expect(result.message.purge_reason).toBe('sent to the wrong recipient')
    expect(result.message.purged_by_agent_id).toBe('agt_operator')
    expect(result.message.purged_at).not.toBeNull()
    db.close()
  })

  it('purge trigger: a raw UPDATE resurrecting the body on a purged row aborts — DB constraint guard', () => {
    const db = freshDb()
    const message = send(db)
    db.purgeMessage({ messageId: message.id, reason: 'x', purgedByAgentId: null })
    const raw = (
      db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
    ).db
    expect(() =>
      raw.prepare("UPDATE messages SET body = 'resurrected' WHERE id = ?").run(message.id)
    ).toThrow(/purge is final/)
    db.close()
  })

  it('purge trigger: un-purging (setting purged_at back to NULL) aborts', () => {
    const db = freshDb()
    const message = send(db)
    db.purgeMessage({ messageId: message.id, reason: 'x', purgedByAgentId: null })
    const raw = (
      db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
    ).db
    expect(() =>
      raw.prepare('UPDATE messages SET purged_at = NULL WHERE id = ?').run(message.id)
    ).toThrow(/purge is final/)
    db.close()
  })

  it('ruling 9: correcting the reason on an already-purged message is allowed (no un-purge)', () => {
    const db = freshDb()
    const message = send(db)
    db.purgeMessage({ messageId: message.id, reason: 'first reason', purgedByAgentId: null })
    const second = db.purgeMessage({
      messageId: message.id,
      reason: 'corrected reason',
      purgedByAgentId: null
    })
    expect(second.outcome).toBe('already_purged')
    if (second.outcome !== 'already_purged') {
      throw new Error('expected already_purged')
    }
    expect(second.message.purge_reason).toBe('corrected reason')
    expect(second.message.body).toBe('')
    db.close()
  })

  it('idempotent: re-purging an already-purged message writes no second gate_refusals row (identical reason)', () => {
    const db = freshDb()
    const message = send(db)
    db.purgeMessage({ messageId: message.id, reason: 'x', purgedByAgentId: null })
    db.purgeMessage({ messageId: message.id, reason: 'x', purgedByAgentId: null })
    const raw = (db as unknown as { db: { prepare: (s: string) => { get: () => { n: number } } } })
      .db
    const count = raw.prepare('SELECT COUNT(*) AS n FROM gate_refusals').get()
    expect(count.n).toBe(0) // neither purge was HARD-gated, so no refusal row either time
    db.close()
  })

  it('T11: a HARD-gated purge reason is refused — guard: gating the reason without the same tiers as a send', () => {
    const db = freshDb()
    const message = send(db)
    const result = db.purgeMessage({
      messageId: message.id,
      reason: 'MERGE-GATE AUDIT: unresolved',
      purgedByAgentId: null
    })
    expect(result.outcome).toBe('refused')
    const fresh = db.getThreadMessagesSince
    void fresh
    // The message must remain live (not silently purged) after a refused reason.
    const raw = (
      db as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }
    ).db
    const row = raw.prepare('SELECT purged_at FROM messages WHERE id = ?').get(message.id) as {
      purged_at: string | null
    }
    expect(row.purged_at).toBeNull()
    db.close()
  })

  it('T7: purging an answered question blanks answer_body but preserves a dedup hash', () => {
    const db = freshDb()
    const asked = send(db, { type: 'question' })
    const answer = send(db, {
      from: 'agent:b',
      to: 'agent:a',
      subject: 're',
      body: 'the answer text'
    })
    const raw = (
      db as unknown as {
        db: {
          prepare: (s: string) => {
            run: (...a: unknown[]) => unknown
            get: (...a: unknown[]) => unknown
          }
        }
      }
    ).db
    raw
      .prepare(
        `INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle, status, answer_message_id, answer_body)
         VALUES (?, 'run_peer_local', 'peer:thr_x', 'agent:a', 'answered', ?, ?)`
      )
      .run(asked.id, answer.id, 'the answer text')

    const result = db.purgeMessage({
      messageId: answer.id,
      reason: 'sensitive',
      purgedByAgentId: null
    })
    expect(result.outcome).toBe('purged')

    const row = raw
      .prepare(
        'SELECT answer_body, answer_body_sha256, answer_purged_at FROM question_threads WHERE message_id = ?'
      )
      .get(asked.id) as {
      answer_body: string
      answer_body_sha256: string
      answer_purged_at: string | null
    }
    expect(row.answer_body).toBe('')
    expect(row.answer_body_sha256).toBe(
      createHash('sha256').update('the answer text', 'utf8').digest('hex')
    )
    expect(row.answer_purged_at).not.toBeNull()
    db.close()
  })
})

describe('purgeThread', () => {
  it('purges every live message on the thread and tombstones the thread row', () => {
    const db = freshDb()
    const thread = db.createThread({
      subject: 'a conversation',
      createdByAgentId: null,
      origin: 'peer',
      participants: [
        { participantKey: 'agent:a', agentId: 'agent:a', handle: 'a' },
        { participantKey: 'agent:b', agentId: 'agent:b', handle: 'b' }
      ]
    })
    const threadId = thread.thread.id
    const m1 = send(db, { threadId })
    const m2 = send(db, { threadId, from: 'agent:b', to: 'agent:a' })
    const result = db.purgeThread({ threadId, reason: 'done', purgedByAgentId: null })
    expect(result.outcome).toBe('purged')
    if (result.outcome !== 'purged') {
      throw new Error('expected purged')
    }
    expect(result.purgedCount).toBe(2)
    // getThread filters purged_at IS NULL (clean-room read) — a purged thread is inspected raw.
    expect(db.getThread(threadId)).toBeUndefined()
    const raw = (
      db as unknown as {
        db: {
          prepare: (s: string) => {
            get: (...a: unknown[]) => { body?: string; purged_at?: string | null }
          }
        }
      }
    ).db
    expect(
      raw.prepare('SELECT purged_at FROM threads WHERE id = ?').get(threadId).purged_at
    ).not.toBeNull()
    expect(raw.prepare('SELECT body FROM messages WHERE id = ?').get(m1.id).body).toBe('')
    expect(raw.prepare('SELECT body FROM messages WHERE id = ?').get(m2.id).body).toBe('')
    db.close()
  })
})

describe('listMessagesByAuthor', () => {
  it('returns messages by sender_agent_id, purged or not', () => {
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
    const message = send(db, {
      from: 'backend-merge',
      senderPaneKey: 'tab1:leaf1',
      senderHostId: 'local'
    })
    db.purgeMessage({ messageId: message.id, reason: 'x', purgedByAgentId: null })
    const agentId = db.getAgentByPaneKey('local', 'tab1:leaf1')?.id
    expect(agentId).toBeDefined()
    const rows = db.listMessagesByAuthor({ senderAgentId: agentId as string })
    expect(rows.map((r) => r.id)).toContain(message.id)
    db.close()
  })
})
