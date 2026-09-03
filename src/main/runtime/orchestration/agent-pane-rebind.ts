// S10-11 R1: split out of agent-directory.ts (at its max-lines budget), same precedent as
// agent-retire.ts / agent-mailbox-repoint.ts. Local, narrower param/result types here (not
// UpsertAgentByPaneSuffixParams/Result from agent-directory.ts) purely to avoid a circular
// import — agent-directory.ts imports remintRow from this file, so this file cannot import
// back from it; every caller's params/result already satisfies these shapes structurally.
import type Database from '../../sqlite/sync-database'
import { repointMailboxOnNameBind, repointMailboxOnReMint } from './agent-mailbox-repoint'
import type { AgentRow } from './types'

// R1: ground truth for "is this row's own pane still alive" — a null pane_key (unresolvable by
// construction: nothing to check) is dead, same as a checked pane that no longer resolves.
export function holderPaneIsLive(
  holder: AgentRow,
  isPaneLive: ((paneKey: string) => boolean) | undefined
): boolean {
  if (holder.pane_key === null) {
    return false
  }
  return (isPaneLive ?? (() => true))(holder.pane_key)
}

export type RemintRowParams = {
  displayName: string
  role: string | null
  hostId: string
  paneKey: string
  terminalHandle: string | null
  processIncarnation: string | null
  worktreeId: string | null
  worktreePath: string | null
  branch: string | null
  title: string | null
  agentLabel: string | null
}

export type RemintRowResult = {
  outcome: 'reminted'
  agent: AgentRow
  repointedMessages: number
  pendingOnOldHandle: number
}

/** R1 rebind, shared by both paths that re-adopt an existing row (found by live pane-suffix
 * match, or by name once the name holder's own pane has been confirmed dead/unresolvable):
 * same UPDATE either way, id preserved, mailbox repoint run, outcome always 'reminted'. Commits
 * and returns — callers do not touch the transaction after invoking this.
 *
 * A pane relaunch mints a brand-new pane_key suffix, so a pane-suffix lookup alone finds
 * nothing even though the agent's own row (under the same display_name) is still sitting there
 * pointed at the now-dead old pane. Before R1 that fell straight to the name-collision branch
 * and, for anything but a derived+gone holder, refused with name_taken — the caller registered
 * under an alternative name (or not at all) and every thread/mailbox tied to the ORIGINAL id
 * went dark for it. Now: a same-name register whose existing holder's pane is confirmed
 * dead/unresolvable re-adopts that row in place instead of refusing — same id, so every caller
 * that resolves identity via getAgentByPaneKey(hostId, thisPaneKey) (agents threads, thread
 * replay, reply, pact, wake delivery) finds the original row again. */
export function remintRow(
  db: Database.Database,
  existing: { id: string; terminal_handle: string | null },
  params: RemintRowParams
): RemintRowResult {
  db.prepare(
    `UPDATE agents SET
       display_name = ?, role = ?, terminal_handle = ?, process_incarnation = ?,
       worktree_id = ?, worktree_path = ?, branch = ?, title = ?, agent_label = ?,
       pane_key = ?, derived = 0, last_seen_at = datetime('now')
     WHERE id = ?`
  ).run(
    params.displayName,
    params.role,
    params.terminalHandle,
    params.processIncarnation,
    params.worktreeId,
    params.worktreePath,
    params.branch,
    params.title,
    params.agentLabel,
    params.paneKey,
    existing.id
  )
  const reminted = db.prepare('SELECT * FROM agents WHERE id = ?').get(existing.id) as AgentRow
  // S10-7 F-C: pending mail follows the agent across a re-mint, same as its identity does.
  const fromHandle = repointMailboxOnReMint(db, existing, params)
  // Ruling 32 Addendum 10 (A3/F-5b): a bare NAME address is a separate stranding surface from
  // the terminal-handle one above — re-resolve both on every re-mint (rename or dead-pane
  // reclaim), since either can leave mail addressed to `params.displayName` unbound.
  const fromName = repointMailboxOnNameBind(db, params.displayName, existing.id, {
    paneKey: params.paneKey,
    hostId: params.hostId
  })
  db.exec('COMMIT')
  return {
    outcome: 'reminted',
    agent: reminted,
    repointedMessages: fromHandle.repointedMessages + fromName.repointedMessages,
    pendingOnOldHandle: fromHandle.pendingOnOldHandle + fromName.pendingOnOldHandle
  }
}
