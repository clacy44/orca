// S10-21a C5/C5a (design v3.2 §2.4; errata 5(p)-5 v2.1 §C.5/§F; Ruling 34 Addendum 16): the
// restore rebind — predicate and transaction, pure DB. Predicate evaluation is
// agent-restore-rebind-predicate.ts (split to stay under the max-lines ratchet). Pact un-pause
// (§2.11 N4) is NOT called here — this returns the paused-pact thread ids for C10 to act on
// post-commit, its own separate call.
//
// FORCED DEVIATION (recorded per _common-rules.md; see the RETURN block for the citation):
//   §2.4 lists "H6 idempotent succession catch-up" as step 4 of ONE `BEGIN IMMEDIATE...COMMIT`.
//   `catchUpThreadSuccession` (agent-thread-succession.ts:272) manages its own transaction and
//   throws ("cannot start a transaction within a transaction") if nested inside another open
//   one. H6 catch-up is inlined here using the same nesting-safe primitive `remintRow` itself
//   uses when it is the one holding the open transaction (`adoptPredecessorThreadMembership`,
//   exported, carries no BEGIN/COMMIT of its own) — same marker-gated idempotence, no behaviour
//   change.
//
// [Ruling 34 Addendum 16(c)] The launch-row write is now INSIDE this function's own transaction,
// via `recordLaunchInTransaction` (agent-launch-sessions.ts, split off `recordLaunch` for
// exactly this caller) — no longer a forced post-commit deviation. A genuine foreign_session_id
// collision rolls back the WHOLE rebind (agent row, mailboxes, threads) and refuses; the prunes
// (host-scoped, self-transacting) still run after this transaction commits, same as
// `recordLaunch`'s own wrapper does for every other caller.
import type Database from '../../sqlite/sync-database'
import { adoptFromPredecessors, adoptPredecessorThreadMembership } from './agent-thread-succession'
import {
  repointMailboxFromBareHandle,
  repointMailboxOnNameBind,
  repointMailboxOnReMint,
  repointMailboxOnSuccession
} from './agent-mailbox-repoint'
import { writeAgentAudit } from './agent-audit-log'
import { recordLaunchInTransaction, setLaunchAgentId } from './agent-launch-sessions'
import { prunePaneRows, pruneGlobalRows } from './agent-launch-sessions-retention'
import {
  evaluateRebindPredicate,
  type RebindRefusalReason,
  type RebindRestoredPaneParams
} from './agent-restore-rebind-predicate'
export type {
  RebindRefusalReason,
  RebindRestoredPaneParams
} from './agent-restore-rebind-predicate'

export type RebindRestoredPaneResult =
  | {
      ok: true
      rebound: true
      agentId: string
      adoptedThreads: number
      repointedMessages: number
      pendingOnOldHandle: number
      pactsToUnpause: string[]
    }
  | { ok: true; rebound: false; agentId: string }
  | { ok: false; reason: RebindRefusalReason }

function pactsAwaitingUnpause(db: Database.Database, agentId: string): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM threads
       WHERE purged_at IS NULL AND pact_state = 'engaged' AND pact_paused_at IS NOT NULL
         AND pact_pause_reason = 'counterpart_gone'
         AND (pact_proposer_agent_id = ? OR pact_with_agent_id = ?)`
    )
    .all(agentId, agentId) as { id: string }[]
  return rows.map((r) => r.id)
}

/** §2.4's rebind: predicate, then the transaction. `db` is the caller's raw handle (same
 * convention as every other orchestration/*.ts primitive) — the caller (C7) never opens a
 * transaction of its own around this call. See the FORCED DEVIATION note above for the one place
 * this cannot literally be "one BEGIN IMMEDIATE...COMMIT" as §2.4's text states. */
export function rebindRestoredPane(
  db: Database.Database,
  params: RebindRestoredPaneParams
): RebindRestoredPaneResult {
  const predicate = evaluateRebindPredicate(db, params)
  if (predicate.kind === 'refuse') {
    // [S10-21a C6, §2.6 SCOPE(a)] Fail-closed contest: a live incumbent still holds this
    // lineage (including C4a's 'conflicting_signals' verdict, which forces this same
    // refusal — resolveIncumbentDeath never reports `dead: true` while d3.liveNow). No
    // rebind, no row change (predicate performed no write besides its own rate bump); one
    // `contested` audit row names the refused claim. Pure DB — no notice from here (the
    // caller, the sweep, owns runtime access for that).
    if (predicate.reason === 'incumbent_alive') {
      writeAgentAudit(db, {
        agentId: predicate.agentId ?? null,
        actorPaneKey: params.newPaneKey,
        actorHostId: params.hostId,
        verb: 'contested',
        outcome: 'refused',
        reasonCode:
          `restore lineage contested: incumbent ` +
          `${params.incumbent.dead ? params.incumbent.signal : params.incumbent.reason} ` +
          `at ${params.ticketPayload.predecessorPaneKey}; claimant ${params.newPaneKey}`
      })
    }
    return { ok: false, reason: predicate.reason }
  }
  if (predicate.kind === 'noop') {
    return { ok: true, rebound: false, agentId: predicate.agentId }
  }
  const { row, targetRow } = predicate

  let adoptedThreads = 0
  let repointedMessages = 0
  let pendingOnOldHandle = 0
  let pactsToUnpause: string[] = []

  db.exec('BEGIN IMMEDIATE')
  try {
    // Step 1: adopt-or-tombstone a derived placeholder sitting on the target leaf. Same sequence
    // as agent-directory-derived-reclaim.ts's reclaimDerivedPlaceholder (the only other call site
    // that adopts a derived row's history onto a different id inside its own transaction).
    if (targetRow) {
      const succession = repointMailboxOnSuccession(db, targetRow.id, row.id, {
        paneKey: params.newPaneKey,
        hostId: params.hostId
      })
      repointedMessages += succession.repointedMessages
      db.prepare(
        `UPDATE agents SET tombstoned_at = datetime('now'), pane_key = NULL,
           role = NULL, title = NULL, worktree_path = NULL WHERE id = ?`
      ).run(targetRow.id)
      const adopted = adoptFromPredecessors(db, params.hostId, [targetRow.id], row.id)
      adoptedThreads += adopted.adoptedThreads
      repointedMessages += adopted.repointedMessages
      if (targetRow.terminal_handle && targetRow.terminal_handle !== params.newTerminalHandle) {
        const bare = repointMailboxFromBareHandle(db, targetRow.terminal_handle, row.id, {
          paneKey: params.newPaneKey,
          hostId: params.hostId
        })
        repointedMessages += bare.repointedMessages
        pendingOnOldHandle += bare.pendingOnOldHandle
      }
    }

    // Step 2: the NARROW update — pane_key/terminal_handle (+last_seen_at), and
    // process_incarnation only when the caller supplied one (Ruling 34 Addendum 16(b): the
    // column exists and the runtime can supply a value, but C5 itself has no runtime handle to
    // derive one from — undefined leaves the column untouched). Never display_name, id,
    // quarantine, or tombstone fields.
    if (params.processIncarnation !== undefined) {
      db.prepare(
        `UPDATE agents SET pane_key = ?, terminal_handle = ?, process_incarnation = ?,
           last_seen_at = datetime('now') WHERE id = ?`
      ).run(params.newPaneKey, params.newTerminalHandle, params.processIncarnation, row.id)
    } else {
      db.prepare(
        `UPDATE agents SET pane_key = ?, terminal_handle = ?, last_seen_at = datetime('now')
         WHERE id = ?`
      ).run(params.newPaneKey, params.newTerminalHandle, row.id)
    }

    // Step 3: mailbox repoints — bare handle then bare name, same order agent-pane-rebind.ts's
    // remintRow uses.
    const fromReMint = repointMailboxOnReMint(
      db,
      { id: row.id, terminal_handle: row.terminal_handle },
      {
        paneKey: params.newPaneKey,
        hostId: params.hostId,
        terminalHandle: params.newTerminalHandle
      }
    )
    repointedMessages += fromReMint.repointedMessages
    pendingOnOldHandle += fromReMint.pendingOnOldHandle
    const fromName = repointMailboxOnNameBind(db, row.display_name, row.id, {
      paneKey: params.newPaneKey,
      hostId: params.hostId
    })
    repointedMessages += fromName.repointedMessages
    pendingOnOldHandle += fromName.pendingOnOldHandle

    // Step 4: H6 idempotent succession catch-up, inlined (FORCED DEVIATION — see file header).
    const hasSuccessionMarker = Boolean(
      db
        .prepare(
          `SELECT 1 FROM agent_audit WHERE agent_id = ? AND verb = 'thread_succession' LIMIT 1`
        )
        .get(row.id)
    )
    if (!hasSuccessionMarker) {
      const caughtUp = adoptPredecessorThreadMembership(db, params.hostId, row.display_name, row.id)
      adoptedThreads += caughtUp.adoptedThreads
      repointedMessages += caughtUp.repointedMessages
    }

    // Step 5 [Ruling 34 Addendum 16(c)]: the launch-row write, INSIDE this transaction. A
    // genuine cross-pane collision rolls back the whole rebind and refuses — nothing above (the
    // adopt/tombstone, the narrow UPDATE, the mailbox repoints, H6 catch-up) is left half-applied.
    const launchResult = recordLaunchInTransaction(db, {
      hostId: params.hostId,
      paneKey: params.newPaneKey,
      agentType: 'claude',
      sessionId: params.ticketPayload.sessionId,
      launchGeneration: params.launchGeneration,
      executionHostId: params.executionHostId,
      evidence: 'sweep_record',
      supersedePaneKey: params.ticketPayload.predecessorPaneKey
    })
    if (!launchResult.ok) {
      db.exec('ROLLBACK')
      return { ok: false, reason: 'launch_row_foreign_session_id' }
    }
    setLaunchAgentId(db, { seq: launchResult.row.seq }, row.id)

    // Pact un-pause is C10's job (§2.11 N4) — this is a read-only lookup of the candidates so
    // C10 can act on them post-commit; no thread row is written here.
    pactsToUnpause = pactsAwaitingUnpause(db, row.id)

    // Step 6: the one audit row. `ticket <id>` is not available here (C5 receives the payload,
    // never the registry/ticket id) — the predecessor/new pane keys and death signal are cited
    // instead, which is what the idempotent-double-fire fence above matches against.
    writeAgentAudit(db, {
      agentId: row.id,
      actorPaneKey: params.newPaneKey,
      actorHostId: params.hostId,
      verb: 'rebind',
      outcome: 'reminted',
      reasonCode:
        `restore lineage rebind: ${params.ticketPayload.predecessorPaneKey} -> ` +
        `${params.newPaneKey}; death=${params.incumbent.dead ? params.incumbent.signal : 'unknown'}`
    })

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  // Post-commit: the §7 prunes, host-scoped and self-transacting, same as recordLaunch's own
  // wrapper runs for every other caller.
  prunePaneRows(db, params.hostId, params.newPaneKey)
  pruneGlobalRows(db, params.hostId)

  return {
    ok: true,
    rebound: true,
    agentId: row.id,
    adoptedThreads,
    repointedMessages,
    pendingOnOldHandle,
    pactsToUnpause
  }
}
