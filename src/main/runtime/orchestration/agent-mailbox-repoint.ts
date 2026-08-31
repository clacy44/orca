// S10-7 F-C: split out of agent-directory.ts (at its max-lines budget), same precedent as
// agent-retire.ts / derived-agent-rows.ts. Its own tiny audit insert (not agent-directory.ts's
// writeAgentAudit) to avoid a circular import between the two files.
import type Database from '../../sqlite/sync-database'

// A re-mint's mailbox repoint touches at most this many unread rows per call — a sane batch,
// not an attempt to migrate an unbounded backlog inline in the register RPC. Any remainder
// stays reachable as bare-handle mail (the S10-0 fallback: getRecipientPaneKeyForBareHandle /
// the existing bare-handle check path), just not yet folded into the durable agent: mailbox.
const MAILBOX_REPOINT_BATCH_CAP = 200

function repointUnreadBareHandleMail(
  db: Database.Database,
  oldHandle: string,
  agentId: string
): number {
  const result = db
    .prepare(
      `UPDATE messages SET to_handle = ?
       WHERE sequence IN (
         SELECT sequence FROM messages WHERE to_handle = ? AND read = 0
         ORDER BY sequence ASC LIMIT ?
       )`
    )
    .run(`agent:${agentId}`, oldHandle, MAILBOX_REPOINT_BATCH_CAP) as { changes: number }
  return result.changes
}

/** Called from inside upsertAgentByPaneSuffix's own re-mint transaction (agent-directory.ts) —
 * same db handle, same BEGIN IMMEDIATE/COMMIT, so a repoint always lands atomically with the
 * re-mint it belongs to and never partially applies. No-ops (returns 0, no audit row) when the
 * handle did not actually change or there was nothing unread to move — an ordinary restart
 * with no pending mail should not spam agent_audit. Purged/quarantine visibility filters read
 * to_handle at query time, so a repointed row is subject to them unchanged. */
export function repointMailboxOnReMint(
  db: Database.Database,
  existing: { id: string; terminal_handle: string | null },
  params: { paneKey: string; hostId: string; terminalHandle: string | null }
): number {
  const oldHandle = existing.terminal_handle
  if (!oldHandle || oldHandle === params.terminalHandle) {
    return 0
  }
  const n = repointUnreadBareHandleMail(db, oldHandle, existing.id)
  if (n > 0) {
    db.prepare(
      `INSERT INTO agent_audit (agent_id, actor_pane_key, actor_host_id, verb, outcome, reason_code)
       VALUES (?, ?, ?, 'mailbox_repoint', 'ok', ?)`
    ).run(existing.id, params.paneKey, params.hostId, `${n} from ${oldHandle}`)
  }
  return n
}
