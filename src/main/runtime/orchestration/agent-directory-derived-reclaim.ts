// F-19 (Ruling 33(a)) B1: split out of agent-directory.ts (at its max-lines budget), same
// precedent as agent-retire.ts / derived-agent-rows.ts / agent-pane-rebind.ts /
// agent-mailbox-repoint.ts / agent-thread-succession.ts. A derived row on the caller's own
// pane is a directory-listing placeholder its "owner" never opted into — when the requested
// name's holder is a DIFFERENT, dead (and non-quarantined) row, this reclaims that identity
// onto the caller's pane instead of refusing, tombstoning the derived placeholder.
import type Database from '../../sqlite/sync-database'
import {
  holderPaneIsLive,
  remintRow,
  type RemintRowParams,
  type RemintRowResult
} from './agent-pane-rebind'
import { repointMailboxFromBareHandle, repointMailboxOnSuccession } from './agent-mailbox-repoint'
import { adoptFromPredecessors } from './agent-thread-succession'
import type { AgentRow } from './types'

export function canReclaimDerivedPlaceholder(
  existing: AgentRow,
  nameHolder: AgentRow,
  isPaneLive: ((paneKey: string) => boolean) | undefined
): boolean {
  return (
    existing.derived === 1 &&
    existing.quarantined !== 1 &&
    nameHolder.quarantined !== 1 &&
    !holderPaneIsLive(nameHolder, isPaneLive)
  )
}

/** Moves the derived row's mail (both its `agent:<id>` successor mail and its own bare-handle
 * backlog), tombstones it to free the UNIQUE pane-suffix slot, adopts its thread/pact
 * membership explicitly (by id — it never shared nameHolder's display_name, so remintRow's own
 * name-keyed succession would never find it), then re-mints nameHolder onto this pane. Same
 * transaction as the caller's (no BEGIN/COMMIT of its own until remintRow's final COMMIT). */
export function reclaimDerivedPlaceholder(
  db: Database.Database,
  existing: { id: string; terminal_handle: string | null },
  nameHolder: AgentRow,
  params: RemintRowParams
): RemintRowResult {
  repointMailboxOnSuccession(db, existing.id, nameHolder.id, {
    paneKey: params.paneKey,
    hostId: params.hostId
  })
  db.prepare(
    `UPDATE agents SET tombstoned_at = datetime('now'), pane_key = NULL,
       role = NULL, title = NULL, worktree_path = NULL WHERE id = ?`
  ).run(existing.id)
  const displaced = adoptFromPredecessors(db, params.hostId, [existing.id], nameHolder.id)
  const displacedMailbox =
    existing.terminal_handle && existing.terminal_handle !== params.terminalHandle
      ? repointMailboxFromBareHandle(db, existing.terminal_handle, nameHolder.id, {
          paneKey: params.paneKey,
          hostId: params.hostId
        })
      : { repointedMessages: 0, pendingOnOldHandle: 0 }
  // F-1 (attacker-lens review, Ruling 33(a) H6a): succession:true — the derived row adopted
  // above is id-keyed (it never shared nameHolder's display_name), but nameHolder itself can
  // have its OWN tombstoned same-name predecessors, found only by remintRow's name-keyed
  // adoptPredecessorThreadMembership. Those two predecessor sets are disjoint (the derived
  // row's display_name != params.displayName on this branch), so nothing is double-adopted.
  // Runs inside this same transaction, before any thread_succession marker is consulted, so the
  // later register-RPC catch-up (which only fires post-commit) never needed to run for this id.
  // F-1 (D-R98 medium, attacker-lens review): repointCallerHandle:true — the caller's own bare
  // terminal handle backlog (e.g. this worktree's own C2 orphan notice) is repointed by
  // remintRow itself now, inside remintRow's own transaction (COMMIT at
  // agent-pane-rebind.ts:214), instead of via a separate repointMailboxFromCallerHandle call
  // made here AFTER that COMMIT in autocommit. Same terminalHandle, same target id
  // (nameHolder.id) either way, so repointedMessages/pendingOnOldHandle are unchanged — only
  // the transaction boundary the move lands in changed.
  const reminted = remintRow(db, nameHolder, params, true, true)
  return {
    ...reminted,
    adoptedThreads: reminted.adoptedThreads + displaced.adoptedThreads,
    blockedByQuarantinedPredecessor:
      reminted.blockedByQuarantinedPredecessor || displaced.blockedByQuarantinedPredecessor,
    repointedMessages:
      reminted.repointedMessages + displaced.repointedMessages + displacedMailbox.repointedMessages,
    pendingOnOldHandle: reminted.pendingOnOldHandle + displacedMailbox.pendingOnOldHandle,
    predecessorCount: reminted.predecessorCount + displaced.predecessorCount
  }
}
