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
export function refuseIfLinkCeilingSaturated(
  db: Database.Database,
  environmentId: string,
  peerDisplayName: string,
  linkLabel: string
): void {
  if (linkRemoteStepCount(db, environmentId) < PACT_STEPS_PER_LINK_CEILING) {
    return
  }
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
