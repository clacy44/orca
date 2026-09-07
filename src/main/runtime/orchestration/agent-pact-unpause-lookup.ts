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
  // S10-21b B17 (D-R138 B-F7) — STOP, contradiction found, NOT applied: the brief's stated fix
  // is a POSITIVE form (`=== 'counterpart_gone'`), fails closed on a missing/NULL ledger row.
  // Source-contradicted: agent-restore-rebind.test.ts's fixtures "fence: no pact row is changed
  // inside the transaction" (:306-336) and "[S10-21a C7l item 8, C10 gap, D-R118 F7] a same-pane
  // (noop) restore with a counterpart_gone-paused pact carries pactsToUnpause out" (~:800-840)
  // both construct a thread with `pact_pause_reason = 'counterpart_gone'` via a raw INSERT/
  // UPDATE and NO accompanying `pact_steps` ledger row at all (a legitimate fixture shape, not
  // a bug in the fixture) — the `===` form excludes both, breaking two pre-existing S10-21a
  // regression tests. Per the brief: "if the `===` form breaks either, STOP and return the
  // fixture." Reverted to the base NEGATIVE form pending a chair/owner decision — either the
  // fixtures gain a ledger row (SCENARIO_CORRECTION, chair call) or the design's "fails closed"
  // requirement is reconciled with the no-ledger-row fixture shape another way.
  return rows
    .map((r) => r.id)
    .filter((id) => latestHostPauseReasonCode(db, id) !== 'counterpart_unreachable')
}
