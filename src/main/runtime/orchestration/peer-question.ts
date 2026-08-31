// S10-2b amendment F: the peer-branch counterparts of db.ts's createQuestion/answerQuestion
// (which fence on a Dispatch's consumer_generation — meaningless for a peer ask). Identity for
// the answer side comes from `to_agent_id` (ruling 3): `answerPeerQuestion` requires the
// attested caller's directory id to equal `question_threads.to_agent_id`, closing the forged-
// `from` unblock ruling 3 names. `runId` is always the caller's PEER_RUN_ID sentinel and
// `dispatch_id` is `'peer:' + threadId` (s10-2-spec.md:120) — passed in by the db.ts wrapper
// rather than imported here, to avoid a require cycle with db.ts. Kept out of db.ts per that
// file's ratchet rule (same precedent as thread-directory.ts/message-purge.ts).
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import { insertGatedMessage, type InsertGatedMessageParams } from './message-gate-writer'
import type { GateVerdict } from '../../../shared/message-body-gate'
import type { MessageRow, QuestionRow } from './types'

type CommonGateOptions = Pick<
  InsertGatedMessageParams,
  'senderPaneKey' | 'senderHostId' | 'acknowledgeGate' | 'infraAllowlist'
>

export type CreatePeerQuestionParams = CommonGateOptions & {
  /** PEER_RUN_ID (db.ts) — injected by the caller to avoid importing db.ts here. */
  runId: string
  threadId: string
  askerHandle: string
  toAgentId: string
  toHandle: string
  question: string
  options?: string[]
}

export type CreatePeerQuestionResult =
  | { outcome: 'created'; question: QuestionRow; message: MessageRow }
  | { outcome: 'refused'; verdict: Extract<GateVerdict, { tier: 'hard' }>; refusalId: number }

export function createPeerQuestion(
  db: Database.Database,
  params: CreatePeerQuestionParams
): CreatePeerQuestionResult {
  // Why not wrapped in this function's own transaction: insertGatedMessage's HARD-refusal path
  // writes its own gate_refusals audit row and must keep it even when nothing else here
  // proceeds — an outer ROLLBACK on refusal would erase the very audit trail the refusal
  // exists to leave (GATE §).
  const inserted = insertGatedMessage(db, {
    from: params.askerHandle,
    to: params.toHandle,
    subject: 'Question',
    body: params.question,
    type: 'question',
    priority: 'high',
    threadId: params.threadId,
    payload: JSON.stringify({ toAgentId: params.toAgentId, options: params.options ?? [] }),
    runId: params.runId,
    senderPaneKey: params.senderPaneKey,
    senderHostId: params.senderHostId,
    acknowledgeGate: params.acknowledgeGate,
    infraAllowlist: params.infraAllowlist,
    verb: 'ask'
  })
  if (inserted.outcome === 'refused') {
    return { outcome: 'refused', verdict: inserted.verdict, refusalId: inserted.refusalId }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `INSERT INTO question_threads
         (message_id, run_id, dispatch_id, asker_handle, to_agent_id, thread_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      inserted.message.id,
      params.runId,
      `peer:${params.threadId}`,
      params.askerHandle,
      params.toAgentId,
      params.threadId
    )
    const question = db
      .prepare('SELECT * FROM question_threads WHERE message_id = ?')
      .get(inserted.message.id) as QuestionRow
    db.exec('COMMIT')
    return { outcome: 'created', question, message: inserted.message }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export type AnswerPeerQuestionParams = CommonGateOptions & {
  /** PEER_RUN_ID (db.ts). */
  runId: string
  messageId: string
  /** The attested caller's directory id — MUST equal question_threads.to_agent_id (ruling 3). */
  callerAgentId: string
  body: string
}

export type AnswerPeerQuestionResult =
  | { outcome: 'answered'; question: QuestionRow; message: MessageRow; duplicate: boolean }
  | { outcome: 'refused'; verdict: Extract<GateVerdict, { tier: 'hard' }>; refusalId: number }
  | { outcome: 'not_found' }
  | { outcome: 'not_the_addressee' }
  | { outcome: 'closed' }

export function answerPeerQuestion(
  db: Database.Database,
  params: AnswerPeerQuestionParams
): AnswerPeerQuestionResult {
  const question = db
    .prepare('SELECT * FROM question_threads WHERE message_id = ?')
    .get(params.messageId) as QuestionRow | undefined
  // Why run_id, not just message_id existing: a dispatch-generation question (db.ts
  // createQuestion) shares this same table — only a row minted by createPeerQuestion carries
  // the PEER_RUN_ID sentinel, so this is the structural marker that this is actually a peer row.
  if (!question || question.run_id !== params.runId) {
    return { outcome: 'not_found' }
  }
  // Why quarantine is not re-checked here (unlike send's agent: guard): the caller identity IS
  // the answerer, resolved by the RPC layer's own attested-caller lookup before this is called —
  // a quarantined agent's pane still attests to its own id; withholding its OUTBOUND replies is
  // a policy choice for a later slice, not the forged-answer vulnerability ruling 3 closes.
  if (question.to_agent_id !== params.callerAgentId) {
    return { outcome: 'not_the_addressee' }
  }
  if (question.status === 'closed') {
    return { outcome: 'closed' }
  }
  if (question.status === 'answered') {
    if (question.answer_body !== params.body || !question.answer_message_id) {
      throw new OrchestrationError(
        'answer_conflict',
        `Question ${params.messageId} already has a different answer.`
      )
    }
    const message = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(question.answer_message_id) as MessageRow
    return { outcome: 'answered', question, message, duplicate: true }
  }

  const original = db.prepare('SELECT * FROM messages WHERE id = ?').get(params.messageId) as
    | MessageRow
    | undefined
  if (!original) {
    return { outcome: 'not_found' }
  }

  const inserted = insertGatedMessage(db, {
    from: original.to_handle,
    to: original.from_handle,
    subject: 'Re: Question',
    body: params.body,
    threadId: question.thread_key ?? question.message_id,
    runId: params.runId,
    senderPaneKey: params.senderPaneKey,
    senderHostId: params.senderHostId,
    acknowledgeGate: params.acknowledgeGate,
    infraAllowlist: params.infraAllowlist,
    verb: 'reply'
  })
  if (inserted.outcome === 'refused') {
    return { outcome: 'refused', verdict: inserted.verdict, refusalId: inserted.refusalId }
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE question_threads
       SET status = 'answered', answer_message_id = ?, answer_body = ?,
           answered_by_agent_id = ?, answered_at = datetime('now')
       WHERE message_id = ? AND status = 'pending'`
    ).run(inserted.message.id, params.body, params.callerAgentId, question.message_id)
    // Why: ask returns thread state directly; leaving the answer unread would deliver it again
    // via check (same rationale as db.ts's dispatch-generation answerQuestion).
    db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(inserted.message.id)
    const answered = db
      .prepare('SELECT * FROM question_threads WHERE message_id = ?')
      .get(question.message_id) as QuestionRow
    db.exec('COMMIT')
    return { outcome: 'answered', question: answered, message: inserted.message, duplicate: false }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
