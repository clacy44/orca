// S10-21b B14 (design §4.6(a), Addendum 6(14), errata NB7) — the per-link `pact_steps` ceiling:
// a link-wide sum, evaluated ONLY at propose/inbound-propose-apply time, refusing a NEW pact
// proposal once the link's aggregate remote-row count is already saturated. Never pauses an
// already-engaged pact (that is the per-pact cap's job, pact-federated-inbound-apply.ts).
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import { PACT_STEPS_PER_LINK_CEILING } from './link-binding-constants'

// idx_pact_steps_remote(actor_is_remote, actor_environment_id, thread_id) answers this sum
// without a full scan (B1).
function linkRemoteStepCount(db: Database.Database, environmentId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM pact_steps WHERE actor_is_remote = 1 AND actor_environment_id = ?`
    )
    .get(environmentId) as { n: number }
  return row.n
}

// Errata NB7's exact refusal shape: names BOTH the retention rule AND the quarantine remedy for
// an uncooperative peer that never releases — stated alongside the retention rule, never in
// place of it.
//
// S10-21b B17 (D-R137 F13): the base implementation took `peerDisplayName`/`linkLabel` from the
// CALLER — propose-apply.ts passed `(senderAgentId, pairedDeviceId)` (a raw remote agent id and
// the link's own device id) and propose-accept.ts passed `(display_name, environment_id)` — so
// the suggested `orca agents quarantine <x>@<y>` named an agent id / raw environment id where
// `resolveOrchestrationWorkerServer` (quarantine's own resolver) expects a saved-environment
// NAME. Resolved HERE instead, from the mirror row this function already keys its count
// query by, so both call sites get the same correct, current values.
export function refuseIfLinkCeilingSaturated(
  db: Database.Database,
  environmentId: string,
  remoteAgentId: string
): void {
  if (linkRemoteStepCount(db, environmentId) < PACT_STEPS_PER_LINK_CEILING) {
    return
  }
  const mirror = db
    .prepare(
      `SELECT display_name, environment_name FROM remote_agents
        WHERE environment_id = ? AND remote_agent_id = ?`
    )
    .get(environmentId, remoteAgentId) as
    | { display_name: string; environment_name: string }
    | undefined
  const peerDisplayName = mirror?.display_name ?? remoteAgentId
  const linkLabel = mirror?.environment_name ?? environmentId
  throw new OrchestrationError(
    'pact_link_ceiling',
    `Refused: this link's remote-row ceiling is saturated (${PACT_STEPS_PER_LINK_CEILING}); ` +
      `released pacts free their rows after 7 days, or purge with ` +
      `orca agents pact --purge-peer-ledger --link ${linkLabel}, or quarantine an uncooperative ` +
      `peer with orca agents quarantine ${peerDisplayName}@${linkLabel}.`,
    {
      nextSteps: [
        `orca agents pact --purge-peer-ledger --link ${linkLabel}`,
        `orca agents quarantine ${peerDisplayName}@${linkLabel}`
      ]
    }
  )
}
