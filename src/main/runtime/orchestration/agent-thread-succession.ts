// S10-11 R2: a tombstoned predecessor's thread_participants rows do not follow a name
// automatically — before R1 (agent-directory.ts), a retire-then-reregister always minted a
// fresh successor id with orphaned membership; even with R1's rebind, a genuinely new pane
// legitimately claiming a tombstoned name still needs its own successor id. This is the one
// mechanism that reattaches that successor to every thread its predecessor(s) belonged to.
import type Database from '../../sqlite/sync-database'
import { repointMailboxOnSuccession } from './agent-mailbox-repoint'

export type ThreadSuccessionOutcome = {
  adoptedThreads: number
  // F-9 (Ruling 32(b)): true when a quarantined predecessor under this name blocked adoption
  // outright (by design — quarantine survives retire, agent-directory.ts's own precedent). The
  // caller renders this so a bare 0 never reads the same as "there was nothing to inherit".
  blockedByQuarantinedPredecessor: boolean
  // F-18 (Ruling 32 Addendum 10 A3): unread mail this successor just inherited from every
  // non-quarantined predecessor's `agent:<old id>` mailbox. Computed BEFORE adoption is blocked
  // by a quarantined predecessor (that branch returns 0 — quarantine locks the mail too).
  repointedMessages: number
}

/** Idempotent: a thread the successor already participates in is left alone (never
 * double-claimed, never overwritten). Transfers regardless of left_at — leaving a thread is
 * still part of the history a successor inherits. Called from inside upsertAgentByPaneSuffix's
 * own transaction (same db handle) so adoption lands atomically with the insert it follows. */
export function adoptPredecessorThreadMembership(
  db: Database.Database,
  hostId: string,
  displayName: string,
  successorId: string
): ThreadSuccessionOutcome {
  // R2 fix: quarantine must survive retire. A quarantined row's own thread membership never
  // transfers (the `quarantined = 0` conjunct below) — but a quarantined predecessor sharing
  // this name also refuses succession OUTRIGHT (both conjuncts, no adoption from any
  // predecessor at all) so a chain of tombstoned rows under the same name cannot launder the
  // locked identity's access onto a fresh registration through an unrelated legitimate
  // predecessor's membership. Retire still frees the NAME (documented two-step); it must never
  // also free the quarantined row's THREADS onto whoever reclaims it.
  const anyQuarantinedPredecessor = db
    .prepare(
      `SELECT 1 FROM agents
       WHERE host_id = ? AND display_name = ? AND tombstoned_at IS NOT NULL
         AND quarantined = 1 AND id != ?`
    )
    .get(hostId, displayName, successorId)
  if (anyQuarantinedPredecessor) {
    return { adoptedThreads: 0, blockedByQuarantinedPredecessor: true, repointedMessages: 0 }
  }

  const predecessors = db
    .prepare(
      `SELECT id FROM agents
       WHERE host_id = ? AND display_name = ? AND tombstoned_at IS NOT NULL
         AND quarantined = 0 AND id != ?`
    )
    .all(hostId, displayName, successorId) as { id: string }[]
  if (predecessors.length === 0) {
    return { adoptedThreads: 0, blockedByQuarantinedPredecessor: false, repointedMessages: 0 }
  }
  return adoptFromPredecessors(
    db,
    hostId,
    predecessors.map((p) => p.id),
    successorId
  )
}

/** F-9b (Ruling 33 Addendum 1): the transfer body itself, split out so a caller that already
 * has its own predecessor id list (not name-keyed — e.g. H5's B1 reclaim, whose displaced
 * derived row never shared the reclaimed name) can drive the same transfer without a second,
 * drifting copy. `adoptPredecessorThreadMembership` (above) is the name-keyed entry point;
 * this is the mechanism both it and a direct caller share. */
export function adoptFromPredecessors(
  db: Database.Database,
  hostId: string,
  predecessorIds: readonly string[],
  successorId: string
): ThreadSuccessionOutcome {
  if (predecessorIds.length === 0) {
    return { adoptedThreads: 0, blockedByQuarantinedPredecessor: false, repointedMessages: 0 }
  }
  const predecessors = predecessorIds.map((id) => ({ id }))

  // F-18: run BEFORE thread membership is adopted below — the predecessor's durable
  // `agent:<old id>` mailbox is a separate stranding surface from thread_participants, and
  // both must land inside this same succession transaction.
  let repointedMessages = 0
  for (const predecessor of predecessors) {
    repointedMessages += repointMailboxOnSuccession(db, predecessor.id, successorId, {
      paneKey: null,
      hostId
    }).repointedMessages
  }

  let adopted = 0
  for (const predecessor of predecessors) {
    const rows = db
      .prepare('SELECT thread_id, participant_key FROM thread_participants WHERE agent_id = ?')
      .all(predecessor.id) as { thread_id: string; participant_key: string }[]
    for (const row of rows) {
      const successorAlreadyIn = db
        .prepare('SELECT 1 FROM thread_participants WHERE thread_id = ? AND participant_key = ?')
        .get(row.thread_id, successorId)
      if (successorAlreadyIn) {
        continue
      }
      db.prepare(
        `UPDATE thread_participants SET participant_key = ?, agent_id = ?
         WHERE thread_id = ? AND participant_key = ?`
      ).run(successorId, successorId, row.thread_id, row.participant_key)
      adopted += 1
    }
    // F-9 (Ruling 32(b)): thread_participants above is membership; a PACT thread's live state
    // rides on three DIRECT agent-id columns on `threads` (pact_proposer_agent_id/
    // pact_with_agent_id/pact_turn_agent_id — pact-shared.ts's requirePactParticipant reads
    // ONLY these, never thread_participants). Adopting membership alone left every pact this
    // predecessor was a party to unreachable — requirePactParticipant kept refusing the
    // successor `not_a_participant` even though `orca agents threads` already listed it as a
    // member, which is exactly the "peers had to open fresh threads" symptom. One UPDATE per
    // predecessor, scoped per-column so a column the predecessor never held is left untouched.
    db.prepare(
      `UPDATE threads SET
         pact_proposer_agent_id =
           CASE WHEN pact_proposer_agent_id = ? THEN ? ELSE pact_proposer_agent_id END,
         pact_with_agent_id =
           CASE WHEN pact_with_agent_id = ? THEN ? ELSE pact_with_agent_id END,
         pact_turn_agent_id =
           CASE WHEN pact_turn_agent_id = ? THEN ? ELSE pact_turn_agent_id END
       WHERE pact_proposer_agent_id = ? OR pact_with_agent_id = ? OR pact_turn_agent_id = ?`
    ).run(
      predecessor.id,
      successorId,
      predecessor.id,
      successorId,
      predecessor.id,
      successorId,
      predecessor.id,
      predecessor.id,
      predecessor.id
    )
  }

  if (adopted > 0) {
    db.prepare(
      `INSERT INTO agent_audit (agent_id, actor_pane_key, actor_host_id, verb, outcome, reason_code)
       VALUES (?, NULL, ?, 'thread_succession', 'ok', ?)`
    ).run(
      successorId,
      hostId,
      `${adopted} thread(s) adopted from ${predecessors.length} predecessor(s)`
    )
  }
  return { adoptedThreads: adopted, blockedByQuarantinedPredecessor: false, repointedMessages }
}

export type UninheritedPredecessorMailOutcome = {
  pendingPeerQuestions: number
  unreadMailOnRetiredId: number
}

// F-9 honesty (Ruling 32 Addendum 9): peer-facing authority (question_threads.to_agent_id) and
// unread mail addressed to the bare `agent:<id>` handle are DELIBERATELY not repointed onto a
// successor (deferred by ruling; see this file's header) -- so a re-register still owes an
// honest count of what did NOT come with it. Summed across every tombstoned predecessor sharing
// this host+name, quarantined or not: quarantine (above) only blocks THREAD adoption, it never
// made this backlog reachable by any other means either way.
export function countUninheritedPredecessorMail(
  db: Database.Database,
  hostId: string,
  displayName: string,
  successorId: string
): UninheritedPredecessorMailOutcome {
  const predecessors = db
    .prepare(
      `SELECT id FROM agents WHERE host_id = ? AND display_name = ? AND tombstoned_at IS NOT NULL AND id != ?`
    )
    .all(hostId, displayName, successorId) as { id: string }[]
  let pendingPeerQuestions = 0
  let unreadMailOnRetiredId = 0
  for (const predecessor of predecessors) {
    const questionRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM question_threads WHERE to_agent_id = ? AND status = 'pending'`
      )
      .get(predecessor.id) as { n: number }
    pendingPeerQuestions += questionRow.n
    const mailRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
         WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery' AND purged_at IS NULL`
      )
      .get(`agent:${predecessor.id}`) as { n: number }
    unreadMailOnRetiredId += mailRow.n
  }
  return { pendingPeerQuestions, unreadMailOnRetiredId }
}

// F-9b (Ruling 33 Addendum 1): before R1/H5, a rename that PROMOTED an existing row (the plain
// `remintRow` fallback, agent-directory.ts) never ran succession at all — a chair whose pane
// held only a derived row, retired then re-registered, silently lost every thread/pact under
// its old name. This is the marker succession's own audit insert (above) already gives for
// free: a `thread_succession` row naming this successor id means adoption already ran for it,
// so a chair that missed it (registered before this fix landed) catches up on its next PLAIN
// register — at most once, since the very success of THIS call writes the same marker.
function hasThreadSuccessionMarker(db: Database.Database, successorId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM agent_audit WHERE agent_id = ? AND verb = 'thread_succession' LIMIT 1`
      )
      .get(successorId)
  )
}

/** Idempotent catch-up, own transaction (called OUTSIDE upsertAgentByPaneSuffix's, from the
 * register RPC, after that call's own transaction has already committed): a no-op (null) once
 * a `thread_succession` marker exists for this successor, so a chair with nothing left to
 * adopt does not re-run the transfer scan on every single register — only the cheap marker
 * check repeats. */
export function catchUpThreadSuccession(
  db: Database.Database,
  hostId: string,
  displayName: string,
  successorId: string
): ThreadSuccessionOutcome | null {
  if (hasThreadSuccessionMarker(db, successorId)) {
    return null
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const outcome = adoptPredecessorThreadMembership(db, hostId, displayName, successorId)
    db.exec('COMMIT')
    return outcome
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
