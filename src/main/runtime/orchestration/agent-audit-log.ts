// Agent-directory audit ledger: append-only rows recording register/retire/quarantine/rebind
// verbs (split from agent-directory.ts to stay under the max-lines ratchet — same precedent as
// agent-retire.ts / agent-rate-limit.ts).
import type Database from '../../sqlite/sync-database'
import type { AgentAuditRow } from './types'

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
