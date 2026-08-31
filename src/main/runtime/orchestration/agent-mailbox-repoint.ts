// S10-7 F-C: split out of agent-directory.ts (at its max-lines budget), same precedent as
// agent-retire.ts / derived-agent-rows.ts. Its own tiny audit insert (not agent-directory.ts's
// writeAgentAudit) to avoid a circular import between the two files.
import type Database from '../../sqlite/sync-database'

// A single repoint UPDATE moves at most this many rows — keeps each statement's scan/lock
// bounded. repointUnreadBareHandleMail loops this in batches (see MAILBOX_REPOINT_MAX_BATCHES)
// so a re-mint drains the old handle's mailbox in full rather than leaving a remainder no later
// call can ever reach: once this transaction commits, `existing.terminal_handle` is overwritten
// and the old handle is gone from the agents row — nothing else remembers it to repoint later.
const MAILBOX_REPOINT_BATCH_SIZE = 200
// Defensive ceiling on total batches per re-mint call. A normal backlog (even a flood of
// hundreds of messages) drains in one or two batches; this only bounds the pathological case
// (an unbounded backlog) so one register call can't turn into unbounded inline work. Any rows
// still unmoved when the ceiling is hit are reported honestly via `pendingOnOldHandle` rather
// than silently stranded.
const MAILBOX_REPOINT_MAX_BATCHES = 10

// Only rows a `current_delivery` mailbox read can ever surface are worth moving (matches
// getUnreadMessages/countUnreadMessages: `delivery_contract = 'current_delivery' AND purged_at
// IS NULL`, db.ts). Moving a `legacy_direct` row off its bare handle breaks the handle-keyed
// legacy lookups it's addressed by (findLegacyWorkerCompletion, promoteLegacyCoordinatorMailFor
// Takeover) for zero benefit — nothing reads `delivery_contract = 'legacy_direct'` at `agent:
// <id>`. A purged row is unreadable everywhere and would just crowd out real mail in the batch.
function repointableMailPredicate(): string {
  return `to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery' AND purged_at IS NULL`
}

function repointUnreadBareHandleMail(
  db: Database.Database,
  oldHandle: string,
  agentId: string
): { moved: number; pendingOnOldHandle: number } {
  const moveBatch = db.prepare(
    `UPDATE messages SET to_handle = ?
     WHERE sequence IN (
       SELECT sequence FROM messages WHERE ${repointableMailPredicate()}
       ORDER BY sequence ASC LIMIT ?
     )`
  )
  let moved = 0
  for (let batch = 0; batch < MAILBOX_REPOINT_MAX_BATCHES; batch += 1) {
    const result = moveBatch.run(`agent:${agentId}`, oldHandle, MAILBOX_REPOINT_BATCH_SIZE) as {
      changes: number
    }
    moved += result.changes
    if (result.changes < MAILBOX_REPOINT_BATCH_SIZE) {
      break
    }
  }
  const pendingOnOldHandle = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${repointableMailPredicate()}`)
      .get(oldHandle) as { n: number }
  ).n
  return { moved, pendingOnOldHandle }
}

export type MailboxRepointOutcome = { repointedMessages: number; pendingOnOldHandle: number }

/** Called from inside upsertAgentByPaneSuffix's own re-mint transaction (agent-directory.ts) —
 * same db handle, same BEGIN IMMEDIATE/COMMIT, so a repoint always lands atomically with the
 * re-mint it belongs to and never partially applies. No-ops (0/0, no audit row) when the handle
 * did not actually change or there was nothing repointable to move — an ordinary restart with
 * no pending mail should not spam agent_audit. `pendingOnOldHandle` is normally 0 (loops to
 * drain); it is nonzero only past MAILBOX_REPOINT_MAX_BATCHES worth of backlog, and those rows
 * are NOT reachable by any other path once this transaction commits (see the batch-size comment
 * above) — a caller that gets a nonzero value should surface it rather than assume the mail is
 * findable elsewhere. */
export function repointMailboxOnReMint(
  db: Database.Database,
  existing: { id: string; terminal_handle: string | null },
  params: { paneKey: string; hostId: string; terminalHandle: string | null }
): MailboxRepointOutcome {
  const oldHandle = existing.terminal_handle
  if (!oldHandle || oldHandle === params.terminalHandle) {
    return { repointedMessages: 0, pendingOnOldHandle: 0 }
  }
  const { moved, pendingOnOldHandle } = repointUnreadBareHandleMail(db, oldHandle, existing.id)
  if (moved > 0) {
    const reason =
      pendingOnOldHandle > 0
        ? `${moved} from ${oldHandle}, ${pendingOnOldHandle} still pending`
        : `${moved} from ${oldHandle}`
    db.prepare(
      `INSERT INTO agent_audit (agent_id, actor_pane_key, actor_host_id, verb, outcome, reason_code)
       VALUES (?, ?, ?, 'mailbox_repoint', 'ok', ?)`
    ).run(existing.id, params.paneKey, params.hostId, reason)
  }
  return { repointedMessages: moved, pendingOnOldHandle }
}
