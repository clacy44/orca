// S10-2b deferral (ruling 8): send-side thread minting. A point-to-point `orchestration.send`
// to `agent:<id>` with no explicit `--thread-id` gets one automatically — reusing the pair's
// existing 1:1 thread if one is live, minting a fresh one otherwise — so two agents can start
// exchanging status messages and land straight in the wait/pact ecosystem without a separate
// `orchestration.threads.create` round trip. Split out of thread-directory.ts (that file's
// max-lines ratchet) rather than db.ts's (ratchet precedent).
import type Database from '../../sqlite/sync-database'
import { createThread } from './thread-directory'
import type { ThreadRow } from './types'

export type FindOrCreatePeerThreadParams = {
  agentAId: string
  agentBId: string
  subjectHint: string | null
}

export type FindOrCreatePeerThreadResult = {
  thread: ThreadRow
  created: boolean
}

// "1:1" is exactly two live (left_at IS NULL) participants, both these agents, on a `peer`-
// origin, non-purged thread — never a question/fanout/legacy thread, and never a group
// conversation a third member later joined (that one keeps its own identity; minting starts a
// fresh 1:1 alongside it, same as any human DM app would).
export function findOrCreatePeerThread(
  db: Database.Database,
  params: FindOrCreatePeerThreadParams
): FindOrCreatePeerThreadResult {
  const existing = db
    .prepare(
      `SELECT t.* FROM threads t
       WHERE t.purged_at IS NULL AND t.origin = 'peer'
         AND EXISTS (SELECT 1 FROM thread_participants p
                     WHERE p.thread_id = t.id AND p.participant_key = ? AND p.left_at IS NULL)
         AND EXISTS (SELECT 1 FROM thread_participants p
                     WHERE p.thread_id = t.id AND p.participant_key = ? AND p.left_at IS NULL)
         AND (SELECT COUNT(*) FROM thread_participants p
              WHERE p.thread_id = t.id AND p.left_at IS NULL) = 2
       ORDER BY t.last_message_at DESC, t.created_at DESC
       LIMIT 1`
    )
    .get(params.agentAId, params.agentBId) as ThreadRow | undefined
  if (existing) {
    return { thread: existing, created: false }
  }
  const { thread } = createThread(db, {
    subject: params.subjectHint?.trim() ? params.subjectHint : 'peer conversation',
    createdByAgentId: params.agentAId,
    participants: [
      { participantKey: params.agentAId, agentId: params.agentAId, role: 'owner' },
      { participantKey: params.agentBId, agentId: params.agentBId, role: 'member' }
    ]
  })
  return { thread, created: true }
}
