// [S10-21a C7d] Split out of agent-restore-rebind.ts so agent-daemon-respawn-handle-refresh.ts
// (a same-pane-key sibling rebind primitive) and agent-restore-rebind.ts can both use the SAME
// query without an import cycle between the two (C7i needs agent-restore-rebind.ts to call
// agent-daemon-respawn-handle-refresh.ts's own `refreshAgentHandleAfterRespawn`, which itself
// needed this query — a cycle absent this split).
import type Database from '../../sqlite/sync-database'

export function pactsAwaitingUnpause(db: Database.Database, agentId: string): string[] {
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
