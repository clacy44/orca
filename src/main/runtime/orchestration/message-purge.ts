// S10-2a PURGE §. Kept out of db.ts per that file's ratchet rule. `purge_reason` runs the SAME
// gate as a send, not just the sanitizer (ruling 9) — a free-text reason is otherwise a
// permanent ungated body-substitute channel. Idempotent: re-purging an already-purged message
// writes no second audit row (PURGE §).
import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { evaluateMessageBodyGate, type GateVerdict } from '../../../shared/message-body-gate'
import { sanitizeMessageText, sanitizeMessageTextForGate } from '../../../shared/message-text'
import type { MessageRow } from './types'

const PURGE_REASON_MAX_LENGTH = 500
const PURGED_SUBJECT = '[purged]'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

type GateActor = {
  actorAgentId: string | null
  actorPaneKey?: string | null
  actorHostId?: string | null
}

type GateReasonResult =
  | { ok: true; sanitizedReason: string }
  | { ok: false; verdict: Extract<GateVerdict, { tier: 'hard' }>; refusalId: number }

function gateReason(
  db: Database.Database,
  verb: string,
  reason: string,
  actor: GateActor,
  acknowledgeGate: boolean | undefined,
  infraAllowlist: readonly string[] | undefined
): GateReasonResult {
  const sanitizedReason = sanitizeMessageText(reason, PURGE_REASON_MAX_LENGTH).value
  // Same gate-text discipline as insertGatedMessage (message-gate-writer.ts): neither raw nor
  // the newline-collapsed stored text, but the normalized-line-preserving form.
  const verdict = evaluateMessageBodyGate({
    body: sanitizeMessageTextForGate(reason),
    infraAllowlist
  })
  if (verdict.tier !== 'hard') {
    return { ok: true, sanitizedReason }
  }
  if (acknowledgeGate) {
    writeRefusalAudit(db, verb, sanitizedReason, actor, verdict, true)
    return { ok: true, sanitizedReason }
  }
  const refusalId = writeRefusalAudit(db, verb, sanitizedReason, actor, verdict, false)
  return { ok: false, verdict, refusalId }
}

function writeRefusalAudit(
  db: Database.Database,
  verb: string,
  reason: string,
  actor: GateActor,
  verdict: Extract<GateVerdict, { tier: 'hard' }>,
  acknowledged: boolean
): number {
  db.prepare(
    `INSERT INTO gate_refusals
       (actor_agent_id, actor_pane_key, actor_host_id, verb, rule_ids, acknowledged,
        body_sha256, body_bytes, subject_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    actor.actorAgentId,
    actor.actorPaneKey ?? null,
    actor.actorHostId ?? null,
    verb,
    JSON.stringify(verdict.ruleIds),
    acknowledged ? 1 : 0,
    sha256Hex(reason),
    Buffer.byteLength(reason, 'utf8'),
    sha256Hex('')
  )
  const row = db.prepare('SELECT seq FROM gate_refusals ORDER BY seq DESC LIMIT 1').get() as {
    seq: number
  }
  return row.seq
}

// Blanks question_threads.answer_body for any row whose answer_message_id is the purged
// message, storing answer_body_sha256 first (ruling 10) — so answerQuestion's dedup compares
// the hash on an at-least-once retry instead of throwing answer_conflict on a benign resend.
function purgeLinkedAnswer(db: Database.Database, messageId: string): void {
  const row = db
    .prepare('SELECT message_id, answer_body FROM question_threads WHERE answer_message_id = ?')
    .get(messageId) as { message_id: string; answer_body: string | null } | undefined
  if (!row) {
    return
  }
  db.prepare(
    `UPDATE question_threads
     SET answer_body_sha256 = ?, answer_purged_at = datetime('now'), answer_body = ''
     WHERE message_id = ?`
  ).run(sha256Hex(row.answer_body ?? ''), row.message_id)
}

function purgeMessageRowInTxn(
  db: Database.Database,
  message: MessageRow,
  sanitizedReason: string,
  purgedByAgentId: string | null
): void {
  db.prepare(
    `UPDATE messages
     SET purged_at = datetime('now'), purge_reason = ?, purged_by_agent_id = ?,
         body = '', subject = ?, payload = NULL
     WHERE id = ?`
  ).run(sanitizedReason, purgedByAgentId, PURGED_SUBJECT, message.id)
  purgeLinkedAnswer(db, message.id)
}

export type PurgeMessageParams = {
  messageId: string
  reason: string
  purgedByAgentId: string | null
  actorPaneKey?: string | null
  actorHostId?: string | null
  acknowledgeGate?: boolean
  infraAllowlist?: readonly string[]
}

export type PurgeMessageResult =
  | { outcome: 'purged'; message: MessageRow; alreadyPurged: false }
  | { outcome: 'already_purged'; message: MessageRow; alreadyPurged: true }
  | { outcome: 'refused'; verdict: Extract<GateVerdict, { tier: 'hard' }>; refusalId: number }
  | { outcome: 'not_found' }

export function purgeMessage(
  db: Database.Database,
  params: PurgeMessageParams
): PurgeMessageResult {
  const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(params.messageId) as
    | MessageRow
    | undefined
  if (!existing) {
    return { outcome: 'not_found' }
  }

  const gated = gateReason(
    db,
    'purge_reason',
    params.reason,
    {
      actorAgentId: params.purgedByAgentId,
      actorPaneKey: params.actorPaneKey,
      actorHostId: params.actorHostId
    },
    params.acknowledgeGate,
    params.infraAllowlist
  )
  if (!gated.ok) {
    return { outcome: 'refused', verdict: gated.verdict, refusalId: gated.refusalId }
  }

  if (existing.purged_at) {
    // Ruling 9: correcting the stored reason on an already-purged row is allowed (the trigger's
    // WHEN clause only fires on a body/subject/payload/un-purge attempt); no second audit row,
    // no re-tombstone.
    db.prepare('UPDATE messages SET purge_reason = ? WHERE id = ?').run(
      gated.sanitizedReason,
      params.messageId
    )
    const corrected = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(params.messageId) as MessageRow
    return { outcome: 'already_purged', message: corrected, alreadyPurged: true }
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    purgeMessageRowInTxn(db, existing, gated.sanitizedReason, params.purgedByAgentId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  const message = db
    .prepare('SELECT * FROM messages WHERE id = ?')
    .get(params.messageId) as MessageRow
  return { outcome: 'purged', message, alreadyPurged: false }
}

export type PurgeThreadParams = {
  threadId: string
  reason: string
  purgedByAgentId: string | null
  actorPaneKey?: string | null
  actorHostId?: string | null
  acknowledgeGate?: boolean
  infraAllowlist?: readonly string[]
}

export type PurgeThreadResult =
  | { outcome: 'purged'; purgedCount: number }
  | { outcome: 'refused'; verdict: Extract<GateVerdict, { tier: 'hard' }>; refusalId: number }

// Gates the reason ONCE before touching any row (same "gate before expansion" discipline as a
// sensitive-thread broadcast) rather than once per message.
export function purgeThread(db: Database.Database, params: PurgeThreadParams): PurgeThreadResult {
  const gated = gateReason(
    db,
    'purge_reason',
    params.reason,
    {
      actorAgentId: params.purgedByAgentId,
      actorPaneKey: params.actorPaneKey,
      actorHostId: params.actorHostId
    },
    params.acknowledgeGate,
    params.infraAllowlist
  )
  if (!gated.ok) {
    return { outcome: 'refused', verdict: gated.verdict, refusalId: gated.refusalId }
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    const liveMessages = db
      .prepare('SELECT * FROM messages WHERE thread_id = ? AND purged_at IS NULL')
      .all(params.threadId) as MessageRow[]
    for (const message of liveMessages) {
      purgeMessageRowInTxn(db, message, gated.sanitizedReason, params.purgedByAgentId)
    }
    db.prepare(
      `UPDATE threads SET purged_at = datetime('now'), purge_reason = ?, purged_by_agent_id = ?
       WHERE id = ?`
    ).run(gated.sanitizedReason, params.purgedByAgentId, params.threadId)
    db.exec('COMMIT')
    return { outcome: 'purged', purgedCount: liveMessages.length }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export type ListMessagesByAuthorParams = {
  senderAgentId: string
  limit?: number
}

export function listMessagesByAuthor(
  db: Database.Database,
  params: ListMessagesByAuthorParams
): MessageRow[] {
  return db
    .prepare(`SELECT * FROM messages WHERE sender_agent_id = ? ORDER BY sequence DESC LIMIT ?`)
    .all(params.senderAgentId, params.limit ?? 50) as MessageRow[]
}
