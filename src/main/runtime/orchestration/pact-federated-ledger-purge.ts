// S10-21b B14 (design §4.6(b), Addendum 6(4)/6(8)/6(14), errata NB6/NB7) — the write side of the
// purge trigger B1 already built (`trg_pact_steps_no_delete`, db.ts): the operator verb
// `orca agents pact --purge-peer-ledger --link <id> [--force-released]`, registered as
// `orchestration.threads.purgePeerLedger` (contract: src/cli/handlers/agents-pact-federated.ts's
// PurgePeerLedgerResult = {purged, nextSteps}).
//
// OBSTACLE (documented, not silently dropped — see this commit's RETURN): `--force-released` on
// a pact this host has released but whose remote rows have NOT yet aged past
// PACT_RELEASED_RETENTION_MS is, per errata NB7, supposed to force-purge those rows early. The
// no-delete trigger B1 built (db.ts's PACT_STEPS_NO_DELETE_TRIGGER_SQL) has exactly two
// exemption disjuncts — era-age, and released-AND-aged — with no third "force" disjunct, and
// this commit's own standing constraints forbid both a schema change and widening/disabling that
// trigger. There is no way to delete those specific rows without one of those two forbidden
// moves. This module therefore REFUSES that specific request (typed, loud, audited-by-refusal)
// rather than silently no-op'ing it or raising a raw, uncaught SQLite abort — the early-purge
// half of `--force-released` is NOT implemented; the "refuse a still-engaged pact's current-era
// rows" half (which needs no trigger change) IS.
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import { PACT_RELEASED_RETENTION_MS } from './link-binding-constants'

export type PurgePeerLedgerParams = {
  linkId: string
  forceReleased?: boolean
}

export type PurgePeerLedgerResult = { purged: number; nextSteps: string[] }

// Mirrors `trg_pact_steps_no_delete`'s WHEN clause exactly (db.ts, PACT_STEPS_NO_DELETE_TRIGGER_SQL)
// so every row this DELETE selects is one the trigger already permits — the trigger never fires
// (aborts) for any row this statement touches.
const ERA_AGE_OR_RELEASED_AGED_PACT_STEPS_PREDICATE = `
  actor_is_remote = 1 AND actor_environment_id = ?
  AND (
    pact_era < IFNULL((SELECT pact_era FROM threads WHERE id = pact_steps.thread_id), -1)
    OR EXISTS (
      SELECT 1 FROM threads t
      WHERE t.id = pact_steps.thread_id
        AND t.pact_state = 'released'
        AND t.pact_release_at IS NOT NULL
        AND (strftime('%s','now') - strftime('%s', t.pact_release_at)) * 1000 >= ?
    )
  )
`

function purgeErasAndAgedPactSteps(db: Database.Database, linkId: string): number {
  const result = db
    .prepare(`DELETE FROM pact_steps WHERE ${ERA_AGE_OR_RELEASED_AGED_PACT_STEPS_PREDICATE}`)
    .run(linkId, PACT_RELEASED_RETENTION_MS)
  return Number(result.changes)
}

// [errata 6(16), NB6 item 3]: `pact_applied_ids` carries no era column (no schema change this
// commit adds one), so only the released-and-aged arm is derivable for it — a still-live,
// re-proposed pact's prior-era applied-ids rows are NOT purgeable by this pass (a narrower
// purge than pact_steps gets, documented here rather than silently claimed).
function purgeReleasedAgedAppliedIds(db: Database.Database, linkId: string): number {
  const result = db
    .prepare(
      `DELETE FROM pact_applied_ids WHERE thread_id IN (
         SELECT id FROM threads
         WHERE pact_peer_environment_id = ? AND pact_state = 'released' AND pact_release_at IS NOT NULL
           AND (strftime('%s','now') - strftime('%s', pact_release_at)) * 1000 >= ?
       )`
    )
    .run(linkId, PACT_RELEASED_RETENTION_MS)
  return Number(result.changes)
}

// A pact this host released but whose remote rows are still inside the retention window — the
// set `--force-released` is meant to reach and cannot, per this module's own header comment.
function countForceReleasedBlockedRows(db: Database.Database, linkId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM pact_steps
       WHERE actor_is_remote = 1 AND actor_environment_id = ?
         AND thread_id IN (
           SELECT id FROM threads
           WHERE pact_peer_environment_id = ? AND pact_state = 'released' AND pact_release_at IS NOT NULL
             AND (strftime('%s','now') - strftime('%s', pact_release_at)) * 1000 < ?
         )`
    )
    .get(linkId, linkId, PACT_RELEASED_RETENTION_MS) as { n: number }
  return row.n
}

// A still-`engaged` (never-released) pact's current-era rows — `--force-released` must always
// be refused against these (design's own explicit line).
function countStillEngagedCurrentEraRows(db: Database.Database, linkId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM pact_steps
       WHERE actor_is_remote = 1 AND actor_environment_id = ?
         AND thread_id IN (
           SELECT id FROM threads
           WHERE pact_peer_environment_id = ? AND pact_state IN ('proposed', 'engaged')
         )
         AND pact_era >= IFNULL((SELECT pact_era FROM threads WHERE id = pact_steps.thread_id), -1)`
    )
    .get(linkId, linkId) as { n: number }
  return row.n
}

export function purgePeerLedger(
  db: Database.Database,
  params: PurgePeerLedgerParams
): PurgePeerLedgerResult {
  if (params.forceReleased) {
    const engagedBlocked = countStillEngagedCurrentEraRows(db, params.linkId)
    if (engagedBlocked > 0) {
      throw new OrchestrationError(
        'pact_purge_refused',
        `Refused: --force-released never reaches a still-engaged pact's current-era rows ` +
          `(${engagedBlocked} row(s) on link ${params.linkId} are on a live, un-released pact).`,
        { nextSteps: [`orca agents pact --purge-peer-ledger --link ${params.linkId}`] }
      )
    }
    const blocked = countForceReleasedBlockedRows(db, params.linkId)
    if (blocked > 0) {
      throw new OrchestrationError(
        'pact_purge_force_released_unsupported',
        `Refused: --force-released would need to purge ${blocked} row(s) on link ` +
          `${params.linkId} still inside the ${PACT_RELEASED_RETENTION_MS}ms retention window — ` +
          `this build's append-only trigger has no bypass for that case without a schema change; ` +
          `wait for the retention window to elapse, or purge without --force-released for the ` +
          `rows already eligible.`,
        { nextSteps: [`orca agents pact --purge-peer-ledger --link ${params.linkId}`] }
      )
    }
  }
  const purgedSteps = purgeErasAndAgedPactSteps(db, params.linkId)
  const purgedApplied = purgeReleasedAgedAppliedIds(db, params.linkId)
  return {
    purged: purgedSteps + purgedApplied,
    nextSteps: []
  }
}
