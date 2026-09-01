// S10-11 R2: a tombstoned predecessor's thread_participants rows do not follow a name
// automatically — before R1 (agent-directory.ts), a retire-then-reregister always minted a
// fresh successor id with orphaned membership; even with R1's rebind, a genuinely new pane
// legitimately claiming a tombstoned name still needs its own successor id. This is the one
// mechanism that reattaches that successor to every thread its predecessor(s) belonged to.
import type Database from '../../sqlite/sync-database'

export type ThreadSuccessionOutcome = { adoptedThreads: number }

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
    return { adoptedThreads: 0 }
  }

  const predecessors = db
    .prepare(
      `SELECT id FROM agents
       WHERE host_id = ? AND display_name = ? AND tombstoned_at IS NOT NULL
         AND quarantined = 0 AND id != ?`
    )
    .all(hostId, displayName, successorId) as { id: string }[]
  if (predecessors.length === 0) {
    return { adoptedThreads: 0 }
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
  return { adoptedThreads: adopted }
}
