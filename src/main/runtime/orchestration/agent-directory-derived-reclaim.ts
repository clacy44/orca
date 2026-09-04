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
  const reminted = remintRow(db, nameHolder, params)
  return {
    ...reminted,
    adoptedThreads: reminted.adoptedThreads + displaced.adoptedThreads,
    blockedByQuarantinedPredecessor:
      reminted.blockedByQuarantinedPredecessor || displaced.blockedByQuarantinedPredecessor,
    repointedMessages:
      reminted.repointedMessages + displaced.repointedMessages + displacedMailbox.repointedMessages,
    pendingOnOldHandle: reminted.pendingOnOldHandle + displacedMailbox.pendingOnOldHandle
  }
}
