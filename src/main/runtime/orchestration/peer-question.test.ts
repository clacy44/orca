// S10-2b amendment F — db-level tests for createPeerQuestion/answerPeerQuestion, complementing
// the RPC end-to-end coverage in rpc/methods/orchestration-peer-ask-reply.test.ts.
import { describe, expect, it } from 'vitest'
import { OrchestrationDb, PEER_RUN_ID } from './db'

function freshDb(): OrchestrationDb {
  return new OrchestrationDb(':memory:')
}

function askAndAnswer(db: OrchestrationDb, body = 'yes, go ahead') {
  const created = db.createPeerQuestion({
    runId: PEER_RUN_ID,
    threadId: 'thr_test',
    askerHandle: 'agent:asker',
    toAgentId: 'agt_answerer',
    toHandle: 'agent:agt_answerer',
    question: 'ok to proceed?'
  })
  if (created.outcome !== 'created') {
    throw new Error(`expected created, got ${created.outcome}`)
  }
  const answered = db.answerPeerQuestion({
    runId: PEER_RUN_ID,
    messageId: created.question.message_id,
    callerAgentId: 'agt_answerer',
    body
  })
  if (answered.outcome !== 'answered') {
    throw new Error(`expected answered, got ${answered.outcome}`)
  }
  return { created, answered }
}

describe('createPeerQuestion', () => {
  it('writes a question_threads row with to_agent_id and the peer: dispatch_id shape', () => {
    const db = freshDb()
    const created = db.createPeerQuestion({
      runId: PEER_RUN_ID,
      threadId: 'thr_1',
      askerHandle: 'agent:a',
      toAgentId: 'agt_b',
      toHandle: 'agent:agt_b',
      question: 'rebase first?'
    })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') {
      throw new Error('expected created')
    }
    expect(created.question.run_id).toBe(PEER_RUN_ID)
    expect(created.question.dispatch_id).toBe('peer:thr_1')
    expect(created.question.to_agent_id).toBe('agt_b')
    expect(created.question.thread_key).toBe('thr_1')
    expect(created.message.type).toBe('question')
    expect(created.message.priority).toBe('high')
    db.close()
  })

  it('a HARD-gated question body is refused and writes no question_threads row (T2-shaped)', () => {
    const db = freshDb()
    const result = db.createPeerQuestion({
      runId: PEER_RUN_ID,
      threadId: 'thr_2',
      askerHandle: 'agent:a',
      toAgentId: 'agt_b',
      toHandle: 'agent:agt_b',
      question: 'SECURITY: prod creds leaked, see attached'
    })
    expect(result.outcome).toBe('refused')
    expect(db.getAllMessagesForHandle('agent:agt_b')).toHaveLength(0)
    db.close()
  })
})

describe('answerPeerQuestion', () => {
  it('happy path: answers a pending peer question and marks it answered', () => {
    const db = freshDb()
    const { answered } = askAndAnswer(db)
    expect(answered.outcome).toBe('answered')
    if (answered.outcome !== 'answered') {
      throw new Error('expected answered')
    }
    expect(answered.duplicate).toBe(false)
    expect(answered.question.answered_by_agent_id).toBe('agt_answerer')
    expect(answered.message.body).toBe('yes, go ahead')
    db.close()
  })

  it('not_found for a message_id that is not a peer question row', () => {
    const db = freshDb()
    const msg = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'not a question',
      body: 'x',
      runId: PEER_RUN_ID,
      verb: 'send'
    })
    if (msg.outcome !== 'stored') {
      throw new Error('expected stored')
    }
    const result = db.answerPeerQuestion({
      runId: PEER_RUN_ID,
      messageId: msg.message.id,
      callerAgentId: 'agt_b',
      body: 'irrelevant'
    })
    expect(result.outcome).toBe('not_found')
    db.close()
  })

  // T4 at the db layer (RPC-layer proof lives in orchestration-peer-ask-reply.test.ts).
  it('not_the_addressee when callerAgentId does not match question_threads.to_agent_id', () => {
    const db = freshDb()
    const created = db.createPeerQuestion({
      runId: PEER_RUN_ID,
      threadId: 'thr_3',
      askerHandle: 'agent:a',
      toAgentId: 'agt_b',
      toHandle: 'agent:agt_b',
      question: 'ok?'
    })
    if (created.outcome !== 'created') {
      throw new Error('expected created')
    }
    const result = db.answerPeerQuestion({
      runId: PEER_RUN_ID,
      messageId: created.question.message_id,
      callerAgentId: 'agt_bystander',
      body: 'forged yes'
    })
    expect(result.outcome).toBe('not_the_addressee')
    const question = db.getQuestion(created.question.message_id)
    expect(question?.status).toBe('pending')
    db.close()
  })

  it('re-answering with the ORIGINAL body is idempotent (duplicate:true)', () => {
    const db = freshDb()
    const { created, answered } = askAndAnswer(db)
    const retry = db.answerPeerQuestion({
      runId: PEER_RUN_ID,
      messageId: created.question.message_id,
      callerAgentId: 'agt_answerer',
      body: 'yes, go ahead'
    })
    expect(retry.outcome).toBe('answered')
    if (retry.outcome !== 'answered') {
      throw new Error('expected answered')
    }
    expect(retry.duplicate).toBe(true)
    expect(retry.message.id).toBe(answered.message.id)
    db.close()
  })

  it('re-answering with a DIFFERENT body is answer_conflict', () => {
    const db = freshDb()
    const { created } = askAndAnswer(db)
    expect(() =>
      db.answerPeerQuestion({
        runId: PEER_RUN_ID,
        messageId: created.question.message_id,
        callerAgentId: 'agt_answerer',
        body: 'a different answer'
      })
    ).toThrow(/answer_conflict|different answer/)
    db.close()
  })

  // T7: purge the answer, then a benign at-least-once retry of the ORIGINAL body must still
  // dedup to duplicate:true — not throw answer_conflict just because the live answer_body
  // column was blanked by the purge. Mutation this kills: dropping the
  // `answer_purged_at`/`answer_body_sha256` comparison and reverting to a plain
  // `question.answer_body !== params.body` check (message-purge.ts already changed the
  // stored value; peer-question.ts must compare the hash when purged).
  it('T7: retrying the original answer after it was purged still dedups, does not answer_conflict', () => {
    const db = freshDb()
    const { created, answered } = askAndAnswer(db)
    const purged = db.purgeMessage({
      messageId: answered.message.id,
      reason: 'sensitive detail',
      purgedByAgentId: null
    })
    expect(purged.outcome).toBe('purged')

    const question = db.getQuestion(created.question.message_id)
    expect(question?.answer_body).toBe('')
    expect(question?.answer_purged_at).not.toBeNull()

    const retry = db.answerPeerQuestion({
      runId: PEER_RUN_ID,
      messageId: created.question.message_id,
      callerAgentId: 'agt_answerer',
      body: 'yes, go ahead'
    })
    expect(retry.outcome).toBe('answered')
    if (retry.outcome !== 'answered') {
      throw new Error('expected answered')
    }
    expect(retry.duplicate).toBe(true)
    // The re-served message is the purged row: body is gone, ask --resume does not re-serve it.
    expect(retry.message.body).toBe('')
    db.close()
  })

  it('closed for a question whose status is closed', () => {
    const db = freshDb()
    const created = db.createPeerQuestion({
      runId: PEER_RUN_ID,
      threadId: 'thr_4',
      askerHandle: 'agent:a',
      toAgentId: 'agt_b',
      toHandle: 'agent:agt_b',
      question: 'ok?'
    })
    if (created.outcome !== 'created') {
      throw new Error('expected created')
    }
    db.closeQuestionsForDispatch(created.question.dispatch_id)
    const result = db.answerPeerQuestion({
      runId: PEER_RUN_ID,
      messageId: created.question.message_id,
      callerAgentId: 'agt_b',
      body: 'too late'
    })
    expect(result.outcome).toBe('closed')
    db.close()
  })
})
