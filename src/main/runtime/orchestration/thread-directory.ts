// S10-2a thread/participant CRUD (SCHEMA v34). Kept out of db.ts per that file's ratchet rule
// (same precedent as agent-directory.ts) — logic lives here, OrchestrationDb methods only
// delegate. Every read filters `purged_at IS NULL`.
import { randomBytes } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import type {
  MessageRow,
  ThreadParticipantRow,
  ThreadPactState,
  ThreadRow,
  ThreadState
} from './types'

function generateThreadId(): string {
  return `thr_${randomBytes(6).toString('hex')}`
}

export type CreateThreadParams = {
  subject: string
  createdByAgentId: string | null
  origin?: 'peer' | 'question' | 'fanout' | 'legacy'
  sensitive?: boolean
  participants: readonly {
    participantKey: string
    agentId?: string | null
    handle?: string | null
    role?: 'owner' | 'member'
  }[]
}

export function createThread(
  db: Database.Database,
  params: CreateThreadParams
): { thread: ThreadRow; participants: ThreadParticipantRow[] } {
  const id = generateThreadId()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `INSERT INTO threads (id, subject, created_by_agent_id, origin, sensitive)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      id,
      params.subject,
      params.createdByAgentId,
      params.origin ?? 'peer',
      params.sensitive ? 1 : 0
    )
    for (const p of params.participants) {
      upsertThreadParticipantInTxn(db, {
        threadId: id,
        participantKey: p.participantKey,
        agentId: p.agentId ?? null,
        handle: p.handle ?? null,
        role: p.role ?? 'member'
      })
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  const thread = getThread(db, id)
  if (!thread) {
    throw new OrchestrationError('thread_create_failed', `Failed to create thread ${id}.`)
  }
  return { thread, participants: listThreadParticipants(db, id) }
}

export function getThread(db: Database.Database, threadId: string): ThreadRow | undefined {
  return db.prepare('SELECT * FROM threads WHERE id = ? AND purged_at IS NULL').get(threadId) as
    | ThreadRow
    | undefined
}

export function listThreadParticipants(
  db: Database.Database,
  threadId: string
): ThreadParticipantRow[] {
  return db
    .prepare('SELECT * FROM thread_participants WHERE thread_id = ? ORDER BY joined_at ASC')
    .all(threadId) as ThreadParticipantRow[]
}

export function isThreadParticipant(
  db: Database.Database,
  threadId: string,
  participantKey: string
): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM thread_participants
         WHERE thread_id = ? AND participant_key = ? AND left_at IS NULL`
      )
      .get(threadId, participantKey) !== undefined
  )
}

export type ListThreadsForParticipantParams = {
  participantKey: string
  state?: ThreadState | 'all'
  limit?: number
}

export function listThreadsForParticipant(
  db: Database.Database,
  params: ListThreadsForParticipantParams
): ThreadRow[] {
  const limit = params.limit ?? 25
  const stateClause = params.state && params.state !== 'all' ? 'AND t.state = ?' : ''
  const args: unknown[] = [params.participantKey]
  if (stateClause) {
    args.push(params.state)
  }
  args.push(limit)
  return db
    .prepare(
      `SELECT t.* FROM threads t
       JOIN thread_participants tp ON tp.thread_id = t.id
       WHERE tp.participant_key = ? AND tp.left_at IS NULL AND t.purged_at IS NULL ${stateClause}
       ORDER BY t.last_message_at DESC
       LIMIT ?`
    )
    .all(...args) as ThreadRow[]
}

export type UpsertThreadParticipantParams = {
  threadId: string
  participantKey: string
  agentId?: string | null
  handle?: string | null
  role?: 'owner' | 'member'
  invitedByAgentId?: string | null
  inviteState?: 'pending' | 'accepted' | 'declined' | null
}

function upsertThreadParticipantInTxn(
  db: Database.Database,
  params: UpsertThreadParticipantParams
): void {
  db.prepare(
    `INSERT INTO thread_participants
       (thread_id, participant_key, agent_id, handle, role, invited_by_agent_id, invite_state)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id, participant_key) DO UPDATE SET
       agent_id = excluded.agent_id,
       handle = excluded.handle,
       left_at = NULL,
       invited_by_agent_id = excluded.invited_by_agent_id,
       invite_state = excluded.invite_state`
  ).run(
    params.threadId,
    params.participantKey,
    params.agentId ?? null,
    params.handle ?? null,
    params.role ?? 'member',
    params.invitedByAgentId ?? null,
    params.inviteState ?? null
  )
}

export function upsertThreadParticipant(
  db: Database.Database,
  params: UpsertThreadParticipantParams
): ThreadParticipantRow {
  upsertThreadParticipantInTxn(db, params)
  return db
    .prepare('SELECT * FROM thread_participants WHERE thread_id = ? AND participant_key = ?')
    .get(params.threadId, params.participantKey) as ThreadParticipantRow
}

// Always allowed (s10-2-spec.md:112) — sets left_at, keeps history rather than deleting the row.
export function leaveThread(db: Database.Database, threadId: string, participantKey: string): void {
  db.prepare(
    `UPDATE thread_participants SET left_at = datetime('now')
     WHERE thread_id = ? AND participant_key = ? AND left_at IS NULL`
  ).run(threadId, participantKey)
}

export function bumpThreadOnMessage(
  db: Database.Database,
  threadId: string,
  message: Pick<MessageRow, 'id' | 'sequence' | 'created_at'>
): void {
  db.prepare(
    `UPDATE threads SET
       last_message_at = ?,
       last_message_id = ?,
       last_message_sequence = ?,
       message_count = message_count + 1
     WHERE id = ?`
  ).run(message.created_at, message.id, message.sequence, threadId)
}

export function setThreadState(
  db: Database.Database,
  threadId: string,
  state: ThreadState
): ThreadRow {
  db.prepare('UPDATE threads SET state = ? WHERE id = ?').run(state, threadId)
  const thread = getThread(db, threadId)
  if (!thread) {
    throw new OrchestrationError('thread_not_found', `Thread ${threadId} not found.`)
  }
  return thread
}

export type SetThreadPactParams = {
  pactWithAgentId: string | null
  pactState: ThreadPactState | null
  pactTurnAgentId: string | null
}

// One-shot engage per s10-2-spec.md:114; S10-3 replaces this with propose/accept/decline/release.
export function setThreadPact(
  db: Database.Database,
  threadId: string,
  params: SetThreadPactParams
): ThreadRow {
  db.prepare(
    `UPDATE threads SET
       pact_with_agent_id = ?, pact_state = ?, pact_turn_agent_id = ?, pact_at = datetime('now')
     WHERE id = ?`
  ).run(params.pactWithAgentId, params.pactState, params.pactTurnAgentId, threadId)
  const thread = getThread(db, threadId)
  if (!thread) {
    throw new OrchestrationError('thread_not_found', `Thread ${threadId} not found.`)
  }
  return thread
}

// Cursor ONLY — never messages.delivered_at (S10-1 ruling B2). Never marks a message read.
export function markThreadRead(
  db: Database.Database,
  threadId: string,
  participantKey: string,
  sequence: number
): void {
  db.prepare(
    `UPDATE thread_participants SET last_read_sequence = MAX(last_read_sequence, ?)
     WHERE thread_id = ? AND participant_key = ?`
  ).run(sequence, threadId, participantKey)
}

export type GetThreadMessagesSinceOmitted = { purged: number; withheld: number }

// Full-thread replay (BUG 4: every participant's side, not one recipient's inbox), unlike
// getThreadMessagesFor. Filters purged rows and rows from a currently-quarantined sender in SQL
// (never in a formatter) per s10-2-spec.md PURGE §; the counts are returned so the caller can
// print the clean-room omission line without a second query.
export function getThreadMessagesSince(
  db: Database.Database,
  threadId: string,
  afterSequence: number | undefined,
  limit = 100
): { messages: MessageRow[]; omitted: GetThreadMessagesSinceOmitted } {
  const sinceClause = afterSequence !== undefined ? 'AND m.sequence > ?' : ''
  const args: unknown[] = [threadId]
  if (afterSequence !== undefined) {
    args.push(afterSequence)
  }

  const liveArgs = [...args, limit]
  const messages = db
    .prepare(
      `SELECT m.* FROM messages m
       LEFT JOIN agents a ON a.id = m.sender_agent_id
       WHERE m.thread_id = ? ${sinceClause}
         AND m.purged_at IS NULL
         AND (a.id IS NULL OR a.quarantined = 0)
       ORDER BY m.sequence ASC
       LIMIT ?`
    )
    .all(...liveArgs) as MessageRow[]

  const purged = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m WHERE m.thread_id = ? ${sinceClause} AND m.purged_at IS NOT NULL`
      )
      .get(...args) as { n: number }
  ).n
  const withheld = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
         JOIN agents a ON a.id = m.sender_agent_id
         WHERE m.thread_id = ? ${sinceClause} AND m.purged_at IS NULL AND a.quarantined = 1`
      )
      .get(...args) as { n: number }
  ).n

  return { messages, omitted: { purged, withheld } }
}
