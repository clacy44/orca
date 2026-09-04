// S10-11 R1: split out of agent-directory.ts (at its max-lines budget), same precedent as
// agent-retire.ts / agent-mailbox-repoint.ts. Local, narrower param/result types here (not
// UpsertAgentByPaneSuffixParams/Result from agent-directory.ts) purely to avoid a circular
// import — agent-directory.ts imports remintRow from this file, so this file cannot import
// back from it; every caller's params/result already satisfies these shapes structurally.
import type Database from '../../sqlite/sync-database'
import {
  repointMailboxFromCallerHandle,
  repointMailboxOnNameBind,
  repointMailboxOnReMint
} from './agent-mailbox-repoint'
import {
  adoptPredecessorThreadMembership,
  countUninheritedPredecessorMail
} from './agent-thread-succession'
import { writeAgentAudit } from './agent-audit-log'
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

// F-19/C1+C2 (Ruling 33(a)): shared by `orchestration.check`'s orphaned-identity notice and the
// idle-edge pane wake — the single row on THIS worktree whose pane went dark and left a name
// waiting for this pane to reclaim (register --name <that name>). Undefined for 0 or >=1
// candidates: an ambiguous or empty match names nothing.
export function findOrphanedIdentityCandidates(
  db: Database.Database,
  hostId: string,
  worktreePath: string,
  isPaneLive: ((paneKey: string) => boolean) | undefined
): AgentRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM agents
       WHERE host_id = ? AND tombstoned_at IS NULL AND derived = 0 AND worktree_path = ?`
    )
    .all(hostId, worktreePath) as AgentRow[]
  return rows.filter((row) => row.quarantined !== 1 && !holderPaneIsLive(row, isPaneLive))
}

export function findSoleOrphanedIdentityCandidate(
  db: Database.Database,
  hostId: string,
  worktreePath: string,
  isPaneLive: ((paneKey: string) => boolean) | undefined
): AgentRow | undefined {
  const candidates = findOrphanedIdentityCandidates(db, hostId, worktreePath, isPaneLive)
  return candidates.length === 1 ? candidates[0] : undefined
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
  // F-9b (Ruling 33 Addendum 1): populated only when `succession` was true — a rename that
  // PROMOTES an existing row into a name whose predecessors are found by that name. 0/false on
  // every other re-mint (a same-identity rebind was never orphaned in the first place).
  adoptedThreads: number
  blockedByQuarantinedPredecessor: boolean
  pendingPeerQuestions: number
  unreadMailOnRetiredId: number
  // F-1/F-7 (attacker-lens review, Ruling 33(a) H6a): predecessor count behind adoptedThreads,
  // for the audit reason string's "N thread(s) from M predecessor(s)".
  predecessorCount: number
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
  params: RemintRowParams,
  // F-9b (Ruling 33 Addendum 1): true ONLY for the rename/promote fallback (a pane's own
  // existing row picking up a name that currently has no holder at all) — the shape where
  // predecessors under the NEW name are found by that name and their threads/pacts/mail never
  // otherwise reach this row. False (default) for every re-mint that re-adopts a row already
  // holding its own identity (a same-name refresh, or H5's dead-pane-by-name takeover) — that
  // row's own history was never orphaned, so there is nothing name-keyed to adopt.
  succession = false,
  // F-8 completion (Ruling 33 Addendum 1) / F-5 (D-R98 medium): required, no default — every
  // call site states its own intent explicitly rather than relying on an implicit true. true
  // runs the bare-caller-handle repoint below (repointMailboxFromCallerHandle) INSIDE this
  // function's own transaction (COMMIT below) — covers the dead-pane-by-name takeover call
  // site (agent-directory.ts's "nameHolder" branch, which otherwise moves only the holder's OLD
  // handle) and agent-directory-derived-reclaim.ts's reclaim call (F-1: that repoint used to run
  // separately, in autocommit, AFTER this function's COMMIT — now it runs here, inside the
  // transaction, same handle and target id, so the totals are unchanged). agent-directory.ts's
  // own "existing" branch passes this explicitly, true only for a genuine derived-placeholder
  // promote (existing.derived === 1 — that row was never a live identity before, so its pane's
  // bare-handle backlog had no earlier chance to be claimed; repointMailboxOnReMint no-ops
  // there because oldHandle === params.terminalHandle). False for agent-directory.ts's mundane
  // same-identity refresh of an already-real row (existing.derived === 0 — unchanged from
  // before this fix).
  repointCallerHandle: boolean
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

  let adoptedThreads = 0
  let blockedByQuarantinedPredecessor = false
  let pendingPeerQuestions = 0
  let unreadMailOnRetiredId = 0
  let predecessorCount = 0
  let successionRepoint = 0
  if (succession && reminted.quarantined === 1) {
    // F-3 (attacker-lens review, Ruling 33(a) H6a): a quarantined successor must never adopt —
    // quarantine survives a rename/promote exactly the way it survives a name-keyed predecessor
    // scan (adoptPredecessorThreadMembership's own guard above). No 'thread_succession' marker
    // is written (nothing was adopted), so an un-quarantine later still lets succession run.
    writeAgentAudit(db, {
      agentId: reminted.id,
      actorPaneKey: params.paneKey,
      actorHostId: params.hostId,
      verb: 'thread_succession_skipped',
      outcome: 'skipped',
      reasonCode: 'succession_skipped_quarantined'
    })
  } else if (succession) {
    // F-18 (via adoptPredecessorThreadMembership): the succession repoint MUST run before
    // countUninheritedPredecessorMail below, same ordering agent-directory.ts's 'created'
    // branch already relies on — otherwise the uninherited count double-counts mail this same
    // call just moved.
    const outcome = adoptPredecessorThreadMembership(
      db,
      params.hostId,
      params.displayName,
      existing.id
    )
    adoptedThreads = outcome.adoptedThreads
    blockedByQuarantinedPredecessor = outcome.blockedByQuarantinedPredecessor
    predecessorCount = outcome.predecessorCount
    successionRepoint = outcome.repointedMessages
    const uninherited = countUninheritedPredecessorMail(
      db,
      params.hostId,
      params.displayName,
      existing.id
    )
    pendingPeerQuestions = uninherited.pendingPeerQuestions
    unreadMailOnRetiredId = uninherited.unreadMailOnRetiredId
  }

  // S10-7 F-C: pending mail follows the agent across a re-mint, same as its identity does.
  const fromHandle = repointMailboxOnReMint(db, existing, params)
  // Ruling 32 Addendum 10 (A3/F-5b): a bare NAME address is a separate stranding surface from
  // the terminal-handle one above — re-resolve both on every re-mint (rename or dead-pane
  // reclaim), since either can leave mail addressed to `params.displayName` unbound.
  const fromName = repointMailboxOnNameBind(db, params.displayName, existing.id, {
    paneKey: params.paneKey,
    hostId: params.hostId
  })
  // F-8 completion: the caller's own CURRENT bare terminal handle (params.terminalHandle) is a
  // stranding surface distinct from repointMailboxOnReMint's OLD-handle move above — mail
  // addressed to it before this register call (e.g. a C2 orphan notice) never otherwise follows
  // the row this call lands on. No-op (0/0) when there is no terminal handle to check.
  const fromCallerHandle =
    repointCallerHandle && params.terminalHandle
      ? repointMailboxFromCallerHandle(db, params.terminalHandle, existing.id, {
          paneKey: params.paneKey,
          hostId: params.hostId
        })
      : { repointedMessages: 0, pendingOnOldHandle: 0 }
  db.exec('COMMIT')
  return {
    outcome: 'reminted',
    agent: reminted,
    repointedMessages:
      successionRepoint +
      fromHandle.repointedMessages +
      fromName.repointedMessages +
      fromCallerHandle.repointedMessages,
    pendingOnOldHandle:
      fromHandle.pendingOnOldHandle +
      fromName.pendingOnOldHandle +
      fromCallerHandle.pendingOnOldHandle,
    adoptedThreads,
    blockedByQuarantinedPredecessor,
    pendingPeerQuestions,
    unreadMailOnRetiredId,
    predecessorCount
  }
}
