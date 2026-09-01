// Agent-directory liveness classification: signals → live/idle/gone, and the row refresh that
// applies it (split from agent-directory.ts for the max-lines ratchet; the directory verbs stay
// there, the pure classification lives here).
import type Database from '../../sqlite/sync-database'
import type { AgentRow, AgentState } from './types'
import { OrchestrationError } from './orchestration-error'
import { getAgentById } from './agent-directory'

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
