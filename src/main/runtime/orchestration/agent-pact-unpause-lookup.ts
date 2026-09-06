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
  // Matches `pauseConditionCleared`'s own predicate exactly (pact-lifecycle.ts): exclude ONLY
  // the link-evidence reason_code, never require the ledger row to equal 'counterpart_gone' —
  // a host row with no ledger match at all (fixture/back-compat path) stays eligible, same as
  // before this commit.
  return rows
    .map((r) => r.id)
    .filter((id) => latestHostPauseReasonCode(db, id) !== 'counterpart_unreachable')
}
