// [S10-21a C7d] Split out of agent-restore-rebind.ts so agent-daemon-respawn-handle-refresh.ts
// (a same-pane-key sibling rebind primitive) and agent-restore-rebind.ts can both use the SAME
// query without an import cycle between the two (C7i needs agent-restore-rebind.ts to call
// agent-daemon-respawn-handle-refresh.ts's own `refreshAgentHandleAfterRespawn`, which itself
// needed this query — a cycle absent this split).
import type Database from '../../sqlite/sync-database'
import { latestHostPauseReasonCode } from './pact-federated-pause-remote-arm'

// S10-21b B15 (design §4.4, errata NB1, CHAIR RULING 21b-E7): `pact_pause_reason =
// 'counterpart_gone'` alone no longer distinguishes the plain K17 local-`agents`-driven pause
// from B15's own link-evidence `counterpart_unreachable` pause — both share the same
// `pact_pause_reason` value (no CHECK widened). Only the host pause ledger row's own
// `reason_code` disambiguates; a link-evidence pause is resumed only by B15's own recovery
// sweep, never by this restore-driven path.
export function pactsAwaitingUnpause(db: Database.Database, agentId: string): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM threads
       WHERE purged_at IS NULL AND pact_state = 'engaged' AND pact_paused_at IS NOT NULL
         AND pact_pause_reason = 'counterpart_gone'
         AND (pact_proposer_agent_id = ? OR pact_with_agent_id = ?)`
    )
    .all(agentId, agentId) as { id: string }[]
  // S10-21b B17b (design v3.1:1111-1116, T32 :1555; O-21b-46 chair ruling): the design's
  // POSITIVE form — a missing/NULL ledger row fails CLOSED, since no producer creates the
  // reason-without-row state after B17's transactional sweep write. The two pre-existing
  // S10-21a fixtures that previously constructed that impossible state (agent-restore-rebind.
  // test.ts) were corrected under the same ruling to seed the matching host pause row.
  return rows
    .map((r) => r.id)
    .filter((id) => latestHostPauseReasonCode(db, id) === 'counterpart_gone')
}
