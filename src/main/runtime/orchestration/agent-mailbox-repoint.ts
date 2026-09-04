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

/** F-9b (Ruling 33 Addendum 1): H5's B1 reclaim tombstones a derived row whose OWN
 * terminal_handle may differ from the caller's current one (a pane relaunch between the
 * derived row minting and this register call) — its bare-handle mailbox is a stranding surface
 * distinct from repointMailboxOnSuccession's `agent:<id>` one above, and distinct from
 * repointMailboxOnReMint's (that one only ever fires for `existing`, never a THIRD row like the
 * displaced derived row here). No-op (0/0, no audit row) when there is no old handle to move
 * off of. */
export function repointMailboxFromBareHandle(
  db: Database.Database,
  oldHandle: string,
  successorId: string,
  actor: { paneKey: string | null; hostId: string }
): MailboxRepointOutcome {
  const { moved, pendingOnOldHandle } = repointUnreadBareHandleMail(db, oldHandle, successorId)
  if (moved > 0) {
    const reason =
      pendingOnOldHandle > 0
        ? `${moved} from ${oldHandle} (displaced predecessor), ${pendingOnOldHandle} still pending`
        : `${moved} from ${oldHandle} (displaced predecessor)`
    db.prepare(
      `INSERT INTO agent_audit (agent_id, actor_pane_key, actor_host_id, verb, outcome, reason_code)
       VALUES (?, ?, ?, 'mailbox_repoint', 'ok', ?)`
    ).run(successorId, actor.paneKey, actor.hostId, reason)
  }
  return { repointedMessages: moved, pendingOnOldHandle }
}

/** F-8 (attacker-lens review, Ruling 33(a) H6a): a derived-placeholder reclaim (H5's B1) moves
 * the DISPLACED derived row's own old handle (repointMailboxFromBareHandle above) and the name
 * holder's old handle (repointMailboxOnReMint below), but never the CALLER's own current bare
 * terminal handle — mail addressed there before the reclaim (e.g. the C2 orphan notice this
 * same worktree's `check` edge inserted, agent-directory-derived-reclaim.ts) stayed on that
 * bare handle instead of following the reclaimed identity. No-op (0/0, no audit row) when
 * there is nothing repointable on the caller's handle. */
export function repointMailboxFromCallerHandle(
  db: Database.Database,
  callerHandle: string,
  holderId: string,
  actor: { paneKey: string | null; hostId: string }
): MailboxRepointOutcome {
  const { moved, pendingOnOldHandle } = repointUnreadBareHandleMail(db, callerHandle, holderId)
  if (moved > 0) {
    const reason =
      pendingOnOldHandle > 0
        ? `${moved} from ${callerHandle} (caller backlog), ${pendingOnOldHandle} still pending`
        : `${moved} from ${callerHandle} (caller backlog)`
    db.prepare(
      `INSERT INTO agent_audit (agent_id, actor_pane_key, actor_host_id, verb, outcome, reason_code)
       VALUES (?, ?, ?, 'mailbox_repoint', 'ok', ?)`
    ).run(holderId, actor.paneKey, actor.hostId, reason)
  }
  return { repointedMessages: moved, pendingOnOldHandle }
}

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

/** F-18 (Ruling 32 Addendum 10 A3): register-after-retire never repointed the predecessor's
 * durable `agent:<old id>` mailbox — mail addressed to it before the retire sat unreadable
 * forever (no read path resolves a tombstoned id). `repointUnreadBareHandleMail`'s predicate
 * (`to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery' AND purged_at IS
 * NULL`) is identical to what an `agent:<old id>` handle needs — reused verbatim, never a second
 * drifting copy. Called from inside the succession transaction (agent-thread-succession.ts), so
 * it lands atomically with thread-membership adoption. */
export function repointMailboxOnSuccession(
  db: Database.Database,
  predecessorId: string,
  successorId: string,
  actor: { paneKey: string | null; hostId: string }
): MailboxRepointOutcome {
  const { moved, pendingOnOldHandle } = repointUnreadBareHandleMail(
    db,
    `agent:${predecessorId}`,
    successorId
  )
  if (moved > 0) {
    const reason =
      pendingOnOldHandle > 0
        ? `${moved} from agent:${predecessorId} (succession), ${pendingOnOldHandle} still pending`
        : `${moved} from agent:${predecessorId} (succession)`
    db.prepare(
      `INSERT INTO agent_audit (agent_id, actor_pane_key, actor_host_id, verb, outcome, reason_code)
       VALUES (?, ?, ?, 'mailbox_repoint', 'ok', ?)`
    ).run(successorId, actor.paneKey, actor.hostId, reason)
  }
  return { repointedMessages: moved, pendingOnOldHandle }
}

// Ruling 32 Addendum 10 (A3/F-5b): a bare DISPLAY NAME addressed before the name was ever bound
// to an agent (`recipient_pane_key IS NULL` — no live terminal resolved it at send time, same
// distinguishing predicate as db.ts's repointStrandedDisplayNameAddressedMessages/v38 repair)
// never gets a second chance once the name registers, because no read path scans a bare-name
// mailbox (orchestration.ts's check, db.getUnreadMessages). Re-resolve on register: same batch
// loop, same audit verb, as the terminal-handle repoint above.
function repointableNameMailPredicate(): string {
  return (
    `to_handle = ? AND read = 0 AND recipient_pane_key IS NULL ` +
    `AND delivery_contract = 'current_delivery' AND purged_at IS NULL`
  )
}

function repointUnreadNameAddressedMail(
  db: Database.Database,
  displayName: string,
  agentId: string
): { moved: number; pendingOnOldHandle: number } {
  const moveBatch = db.prepare(
    `UPDATE messages SET to_handle = ?
     WHERE sequence IN (
       SELECT sequence FROM messages WHERE ${repointableNameMailPredicate()}
       ORDER BY sequence ASC LIMIT ?
     )`
  )
  let moved = 0
  for (let batch = 0; batch < MAILBOX_REPOINT_MAX_BATCHES; batch += 1) {
    const result = moveBatch.run(`agent:${agentId}`, displayName, MAILBOX_REPOINT_BATCH_SIZE) as {
      changes: number
    }
    moved += result.changes
    if (result.changes < MAILBOX_REPOINT_BATCH_SIZE) {
      break
    }
  }
  const pendingOnOldHandle = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${repointableNameMailPredicate()}`)
      .get(displayName) as { n: number }
  ).n
  return { moved, pendingOnOldHandle }
}

/** Called from inside upsertAgentByPaneSuffix's own transaction (agent-directory.ts), on BOTH
 * the fresh-insert and re-mint paths — a name can be bound to an agent either way. No-ops (0/0,
 * no audit row) when nothing was stranded under this name. */
export function repointMailboxOnNameBind(
  db: Database.Database,
  displayName: string,
  agentId: string,
  actor: { paneKey: string; hostId: string }
): MailboxRepointOutcome {
  const { moved, pendingOnOldHandle } = repointUnreadNameAddressedMail(db, displayName, agentId)
  if (moved > 0) {
    const reason =
      pendingOnOldHandle > 0
        ? `${moved} from bare name "${displayName}", ${pendingOnOldHandle} still pending`
        : `${moved} from bare name "${displayName}"`
    db.prepare(
      `INSERT INTO agent_audit (agent_id, actor_pane_key, actor_host_id, verb, outcome, reason_code)
       VALUES (?, ?, ?, 'mailbox_repoint', 'ok', ?)`
    ).run(agentId, actor.paneKey, actor.hostId, reason)
  }
  return { repointedMessages: moved, pendingOnOldHandle }
}
