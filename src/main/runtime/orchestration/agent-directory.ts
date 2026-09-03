// S10-1 agent directory CRUD (SCHEMA v33). Kept out of db.ts per the repo's ratchet rule for
// that file — logic lives here, db.ts's OrchestrationDb methods only delegate. Every read here
// filters `tombstoned_at IS NULL` (CONTAINMENT #8); quarantine is a read-time filter the RPC
// layer applies on top of listAgents, not enforced here (list still needs to show quarantined
// rows with `[quarantined]`, per CONTAINMENT #7).
import { randomBytes } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { holderPaneIsLive, remintRow } from './agent-pane-rebind'
import {
  adoptPredecessorThreadMembership,
  countUninheritedPredecessorMail
} from './agent-thread-succession'
import type { AgentRow, AgentState } from './types'

// Why a local generator, not db.ts's generateId: importing it back from db.ts (which will
// import this module to delegate) would create a require cycle between the two files.
function generateAgentId(): string {
  return `agt_${randomBytes(6).toString('hex')}`
}

const MAX_NAME_COLLISION_SUFFIX = 20

export type UpsertAgentByPaneSuffixParams = {
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
  originHandle: string | null
  originHostId: string
  // R1: ground truth for "is the NAME HOLDER's own pane still alive" — never the stored
  // `state` column, which is refreshed lazily and can lag well past an actual pane relaunch.
  // Omitted defaults to "assume live": the conservative direction, since it can only ever
  // fall back to the pre-R1 name_taken refusal, never mistakenly steal a still-live identity.
  isPaneLive?: (paneKey: string) => boolean
}

export type UpsertAgentByPaneSuffixResult =
  | {
      outcome: 'created'
      agent: AgentRow
      adoptedThreads: number
      blockedByQuarantinedPredecessor: boolean
      // F-9 (Ruling 32 Addendum 9): what a tombstoned predecessor's peer-facing authority and
      // bare-handle mailbox left behind -- never repointed, so register owes an honest count.
      pendingPeerQuestions: number
      unreadMailOnRetiredId: number
    }
  | { outcome: 'reminted'; agent: AgentRow; repointedMessages: number; pendingOnOldHandle: number }
  | {
      outcome: 'name_taken'
      alternative: string
      // R1: set only when the collision is against a row whose pane resolved live — names the
      // pane a caller can go inspect, never populated for the quarantined-row lock case.
      livePaneKey: string | null
      liveTerminalHandle: string | null
      // S10-11 verify: true only on the RENAME path when the holder is a DIFFERENT row whose
      // pane is dead — register never destroys that identity to free the name (the operator
      // decides, via `orca agents retire`); this flag lets the refusal say so.
      holderPaneDead: boolean
    }

function paneSuffix(paneKey: string): string {
  const idx = paneKey.indexOf(':')
  return idx === -1 ? paneKey : paneKey.slice(idx + 1)
}

function findByPaneSuffix(
  db: Database.Database,
  hostId: string,
  paneKey: string
): AgentRow | undefined {
  return db
    .prepare(
      `SELECT * FROM agents
       WHERE host_id = ? AND tombstoned_at IS NULL
         AND pane_key IS NOT NULL AND substr(pane_key, instr(pane_key, ':') + 1) = ?`
    )
    .get(hostId, paneSuffix(paneKey)) as AgentRow | undefined
}

function findByName(
  db: Database.Database,
  hostId: string,
  displayName: string
): AgentRow | undefined {
  return db
    .prepare(
      'SELECT * FROM agents WHERE host_id = ? AND display_name = ? AND tombstoned_at IS NULL'
    )
    .get(hostId, displayName) as AgentRow | undefined
}

function reclaimableHolder(holder: AgentRow): boolean {
  return holder.state === 'gone' && holder.derived === 1
}

function nextFreeAlternative(db: Database.Database, hostId: string, base: string): string {
  for (let suffix = 2; suffix <= MAX_NAME_COLLISION_SUFFIX; suffix += 1) {
    const truncatedBase = base.slice(0, Math.max(1, 30 - String(suffix).length))
    const candidate = `${truncatedBase}-${suffix}`
    if (!findByName(db, hostId, candidate)) {
      return candidate
    }
  }
  return `${base.slice(0, 26)}-${randomBytes(2).toString('hex')}`
}

/** Idempotent on the pane-key suffix (CONTAINMENT precedent: tabId changes when a pane moves
 * tabs, the leaf identity does not). Never silently renames the caller on a name collision.
 *
 * R1 (S10-11, agent-pane-rebind.ts): a same-name register whose existing holder's pane is
 * confirmed dead/unresolvable re-adopts that row in place (remintRow) instead of refusing —
 * same id, so every caller that resolves identity via getAgentByPaneKey(hostId, thisPaneKey)
 * (agents threads, thread replay, reply, pact, wake delivery) finds the original row again. */
export function upsertAgentByPaneSuffix(
  db: Database.Database,
  params: UpsertAgentByPaneSuffixParams
): UpsertAgentByPaneSuffixResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = findByPaneSuffix(db, params.hostId, params.paneKey)
    if (existing) {
      // R1 name-collision guard, rename path: an already-registered pane re-registering with a
      // NEW display_name can collide with a name a *different* row holds. remintRow's UPDATE
      // writes display_name unconditionally, so without this check that collision reached raw
      // SQLite (`UNIQUE constraint failed: agents.host_id, agents.display_name`) instead of the
      // typed name_taken the chair's ruling requires. Same decision the no-pane-match branch
      // below makes, applied here before the UPDATE runs.
      if (params.displayName !== existing.display_name) {
        const nameHolder = findByName(db, params.hostId, params.displayName)
        if (nameHolder && nameHolder.id !== existing.id) {
          // A DIFFERENT agent's row holds the requested name. Register never destroys that
          // identity to free a name — live, dead, or in between (S10-11 verify blocker: the
          // prior draft tombstoned a dead-pane holder here, stranding its queued mail and
          // erasing its forensic record). Dead holders are the OPERATOR's call: retire frees
          // the name; the typed refusal below says exactly that.
          const holderDead =
            nameHolder.quarantined !== 1 && !holderPaneIsLive(nameHolder, params.isPaneLive)
          const alternative = nextFreeAlternative(db, params.hostId, params.displayName)
          db.exec('COMMIT')
          return {
            outcome: 'name_taken',
            alternative,
            livePaneKey: nameHolder.quarantined === 1 || holderDead ? null : nameHolder.pane_key,
            liveTerminalHandle:
              nameHolder.quarantined === 1 || holderDead ? null : nameHolder.terminal_handle,
            holderPaneDead: holderDead
          }
        }
      }
      return remintRow(db, existing, params)
    }

    const nameHolder = findByName(db, params.hostId, params.displayName)
    if (nameHolder) {
      // Quarantined: name stays locked regardless of pane liveness — existing semantics.
      if (nameHolder.quarantined !== 1 && reclaimableHolder(nameHolder)) {
        db.prepare(
          `UPDATE agents SET tombstoned_at = datetime('now'), pane_key = NULL,
             role = NULL, title = NULL, worktree_path = NULL WHERE id = ?`
        ).run(nameHolder.id)
      } else if (nameHolder.quarantined === 1 || holderPaneIsLive(nameHolder, params.isPaneLive)) {
        // Locked (quarantined) or the holder's pane is genuinely still live: refuse, never
        // silently rename, never a raw INSERT that could hit the UNIQUE constraint.
        const alternative = nextFreeAlternative(db, params.hostId, params.displayName)
        db.exec('COMMIT')
        return {
          outcome: 'name_taken',
          alternative,
          livePaneKey: nameHolder.quarantined === 1 ? null : nameHolder.pane_key,
          liveTerminalHandle: nameHolder.quarantined === 1 ? null : nameHolder.terminal_handle,
          holderPaneDead: false
        }
      } else {
        // R1: non-derived holder, not quarantined, pane confirmed dead/unresolvable (or the
        // row never had one) — rebind in place rather than mint a second, anonymous identity.
        return remintRow(db, nameHolder, params)
      }
    }

    const id = generateAgentId()
    db.prepare(
      `INSERT INTO agents (
         id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
         worktree_id, worktree_path, branch, title, agent_label, state, derived,
         origin_kind, origin_pane_key, origin_handle, origin_host_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', 0, 'pane', ?, ?, ?)`
    ).run(
      id,
      params.displayName,
      params.role,
      params.hostId,
      params.paneKey,
      params.terminalHandle,
      params.processIncarnation,
      params.worktreeId,
      params.worktreePath,
      params.branch,
      params.title,
      params.agentLabel,
      params.paneKey,
      params.originHandle,
      params.originHostId
    )
    const created = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow
    // R2: a tombstoned predecessor under this same host+name (retired, or just tombstoned
    // above by the reclaim branch) leaves its thread membership behind unless adopted here.
    const { adoptedThreads, blockedByQuarantinedPredecessor } = adoptPredecessorThreadMembership(
      db,
      params.hostId,
      params.displayName,
      id
    )
    const { pendingPeerQuestions, unreadMailOnRetiredId } = countUninheritedPredecessorMail(
      db,
      params.hostId,
      params.displayName,
      id
    )
    db.exec('COMMIT')
    return {
      outcome: 'created',
      agent: created,
      adoptedThreads,
      blockedByQuarantinedPredecessor,
      pendingPeerQuestions,
      unreadMailOnRetiredId
    }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getAgentById(db: Database.Database, id: string): AgentRow | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ? AND tombstoned_at IS NULL').get(id) as
    | AgentRow
    | undefined
}

export function getAgentByName(
  db: Database.Database,
  hostId: string,
  displayName: string
): AgentRow | undefined {
  return findByName(db, hostId, displayName)
}

export type ListAgentsParams = {
  hostId?: string
  state?: AgentState
  includeDerived?: boolean
  includeQuarantined?: boolean
  limit?: number
}

export type ListAgentsResult = {
  agents: AgentRow[]
  liveCount: number
  derivedCount: number
  omitted: { quarantined: number; derived: number }
}

/** Read-only listing over the stored rows. Refreshing derived rows from the live terminal
 * graph (runtime.listTerminals()) is RPC-layer (S10-1b) — this is the pure DB read beneath it. */
export function listAgents(db: Database.Database, params: ListAgentsParams = {}): ListAgentsResult {
  const conditions: string[] = ['tombstoned_at IS NULL']
  const args: string[] = []
  if (params.hostId) {
    conditions.push('host_id = ?')
    args.push(params.hostId)
  }
  if (params.state) {
    conditions.push('state = ?')
    args.push(params.state)
  }
  const allRows = db
    .prepare(`SELECT * FROM agents WHERE ${conditions.join(' AND ')} ORDER BY registered_at ASC`)
    .all(...args) as AgentRow[]

  const omittedQuarantined = params.includeQuarantined
    ? 0
    : allRows.filter((row) => row.quarantined === 1).length
  const omittedDerived =
    params.includeDerived === false ? allRows.filter((row) => row.derived === 1).length : 0

  let visible = allRows
  if (!params.includeQuarantined) {
    visible = visible.filter((row) => row.quarantined === 0)
  }
  if (params.includeDerived === false) {
    visible = visible.filter((row) => row.derived === 0)
  }
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200)
  visible = visible.slice(0, limit)

  return {
    agents: visible,
    liveCount: allRows.filter((row) => row.state === 'live').length,
    derivedCount: allRows.filter((row) => row.derived === 1).length,
    omitted: { quarantined: omittedQuarantined, derived: omittedDerived }
  }
}

export { writeAgentAudit, type WriteAgentAuditParams } from './agent-audit-log'
