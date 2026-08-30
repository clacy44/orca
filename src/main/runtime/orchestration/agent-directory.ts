// S10-1 agent directory CRUD (SCHEMA v33). Kept out of db.ts per the repo's ratchet rule for
// that file — logic lives here, db.ts's OrchestrationDb methods only delegate. Every read here
// filters `tombstoned_at IS NULL` (CONTAINMENT #8); quarantine is a read-time filter the RPC
// layer applies on top of listAgents, not enforced here (list still needs to show quarantined
// rows with `[quarantined]`, per CONTAINMENT #7).
import { randomBytes } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import type { AgentAuditRow, AgentRow, AgentState } from './types'

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
}

export type UpsertAgentByPaneSuffixResult =
  | { outcome: 'created'; agent: AgentRow }
  | { outcome: 'reminted'; agent: AgentRow }
  | { outcome: 'name_taken'; alternative: string }

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
 * tabs, the leaf identity does not). Never silently renames the caller on a name collision. */
export function upsertAgentByPaneSuffix(
  db: Database.Database,
  params: UpsertAgentByPaneSuffixParams
): UpsertAgentByPaneSuffixResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = findByPaneSuffix(db, params.hostId, params.paneKey)
    if (existing) {
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
      db.exec('COMMIT')
      return { outcome: 'reminted', agent: reminted }
    }

    const nameHolder = findByName(db, params.hostId, params.displayName)
    if (nameHolder) {
      if (!reclaimableHolder(nameHolder)) {
        const alternative = nextFreeAlternative(db, params.hostId, params.displayName)
        db.exec('COMMIT')
        return { outcome: 'name_taken', alternative }
      }
      db.prepare(
        `UPDATE agents SET tombstoned_at = datetime('now'), pane_key = NULL,
           role = NULL, title = NULL, worktree_path = NULL WHERE id = ?`
      ).run(nameHolder.id)
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
    db.exec('COMMIT')
    return { outcome: 'created', agent: created }
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

export type AgentLivenessSignals = {
  paneResolves: boolean
  lastAgentStatus: 'working' | 'permission' | 'idle' | null
  observedLive: boolean
  lastSeenAt: string
  now: string
  goneAfterMs?: number
}

const DEFAULT_GONE_AFTER_MS = 15 * 60 * 1000

/** Pure classifier for the spec's liveness predicate (never claimed by register). `pushable`
 * mirrors the exact ambient-push gate: only a truly-idle, live-observed pane is pushable —
 * a cold-restored idle row (observedLive===false) must never read as `live` or `pushable`. */
export function classifyAgentLiveness(signals: AgentLivenessSignals): {
  state: AgentState
  pushable: boolean
} {
  if (!signals.paneResolves) {
    const goneAfterMs = signals.goneAfterMs ?? DEFAULT_GONE_AFTER_MS
    const ageMs = Date.parse(signals.now) - Date.parse(signals.lastSeenAt)
    return { state: ageMs > goneAfterMs ? 'gone' : 'idle', pushable: false }
  }
  if (!signals.observedLive) {
    return { state: 'idle', pushable: false } // cold restore
  }
  if (signals.lastAgentStatus === 'working' || signals.lastAgentStatus === 'permission') {
    return { state: 'live', pushable: false }
  }
  return { state: 'idle', pushable: true }
}

export type RefreshAgentLivenessParams = {
  id: string
  state: AgentState
  terminalHandle: string | null
  processIncarnation: string | null
}

export function refreshAgentLiveness(
  db: Database.Database,
  params: RefreshAgentLivenessParams
): AgentRow {
  db.prepare(
    `UPDATE agents SET state = ?, terminal_handle = ?, process_incarnation = ?,
       last_seen_at = datetime('now')
     WHERE id = ? AND tombstoned_at IS NULL`
  ).run(params.state, params.terminalHandle, params.processIncarnation, params.id)
  const row = getAgentById(db, params.id)
  if (!row) {
    throw new OrchestrationError('agent_unknown', `Agent ${params.id} was not found.`)
  }
  return row
}

export type SetAgentQuarantineParams = {
  id: string
  quarantined: boolean
  reasonCode: string | null
}

export function setAgentQuarantine(
  db: Database.Database,
  params: SetAgentQuarantineParams
): AgentRow {
  db.prepare(
    `UPDATE agents SET quarantined = ?, quarantine_reason_code = ?,
       quarantined_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
     WHERE id = ? AND tombstoned_at IS NULL`
  ).run(params.quarantined ? 1 : 0, params.reasonCode, params.quarantined ? 1 : 0, params.id)
  const row = getAgentById(db, params.id)
  if (!row) {
    throw new OrchestrationError('agent_unknown', `Agent ${params.id} was not found.`)
  }
  return row
}

export type WriteAgentAuditParams = {
  agentId: string | null
  actorPaneKey: string | null
  actorHostId: string | null
  verb: string
  outcome: string
  reasonCode: string | null
}

export function writeAgentAudit(
  db: Database.Database,
  params: WriteAgentAuditParams
): AgentAuditRow {
  db.prepare(
    `INSERT INTO agent_audit (agent_id, actor_pane_key, actor_host_id, verb, outcome, reason_code)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    params.agentId,
    params.actorPaneKey,
    params.actorHostId,
    params.verb,
    params.outcome,
    params.reasonCode
  )
  return db.prepare('SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1').get() as AgentAuditRow
}

// checkAndBumpRate / CheckAndBumpRateParams / RateLimitResult moved to ./agent-rate-limit.ts
// (kept out of this file to stay under the max-lines ratchet); db.ts imports it directly.
