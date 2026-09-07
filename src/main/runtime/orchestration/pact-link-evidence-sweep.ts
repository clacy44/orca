// S10-21b B15 (design §3.3, Addendum 6(13), errata NB2/NB3/NB5) — the sweep's TWO new
// producers: link-evidence-driven auto-pause and its auto-resume counterpart. Neither is
// relayed (§2.7: "not relayed — a pause whose cause is our observation of them"), so this file
// writes the host ledger row directly rather than through emitFederatedPactSideEffect. Pure DB
// layer — like `pact-lifecycle-autopause.ts`'s `AutoPauseOutcome`, the wake call happens at the
// caller (link-binding-prover-maintenance.ts, which holds the real runtime), never in here.
//
// Idempotency (NB5) is structural, not a separate tracked flag: the pause pass only ever
// selects `pact_paused_at IS NULL` threads, so a thread already paused this episode is never
// reselected by a later qualifying scan — one host pause row per pact per episode, for free.
// The link-scoped audit (once per link per episode, not once per pact) is approximated as "one
// audit call per sweep tick that actually pauses >=1 pact for that (link, environment)" — once
// every engaged pact on a link is paused, a repeat qualifying scan produces zero new pauses and
// therefore no repeat audit row, closing the same episode for the audit dimension too.
import type Database from '../../sqlite/sync-database'
import type { ThreadRow } from './types'
import { getScanFact } from './link-binding-observations-store'
import { PACT_LINK_SILENCE_MS, PACT_LINK_RECOVERY_MS } from './link-binding-constants'
import { auditPact, insertPactStepRow } from './pact-shared'
import { latestHostPauseReasonCode } from './pact-federated-pause-remote-arm'

type FederatedLink = { linkDeviceId: string; environmentId: string }

export type PactLinkEvidenceOutcome = {
  threadId: string
  proposerAgentId: string
  withAgentId: string
}

export type PactLinkEvidenceSweepResult = {
  paused: PactLinkEvidenceOutcome[]
  resumed: PactLinkEvidenceOutcome[]
}

function toOutcome(thread: ThreadRow): PactLinkEvidenceOutcome {
  return {
    threadId: thread.id,
    proposerAgentId: thread.pact_proposer_agent_id as string,
    withAgentId: thread.pact_with_agent_id as string
  }
}

function distinctEngagedFederatedLinks(db: Database.Database): FederatedLink[] {
  return db
    .prepare(
      `SELECT DISTINCT pact_peer_link_device_id AS linkDeviceId,
              pact_peer_environment_id AS environmentId
       FROM threads
       WHERE purged_at IS NULL AND pact_state = 'engaged' AND pact_paused_at IS NULL
         AND pact_peer_link_device_id IS NOT NULL AND pact_peer_environment_id IS NOT NULL`
    )
    .all() as FederatedLink[]
}

// §3.3 fact 1 pause rule: `outcome='unreachable' AND now - unreachable_since >=
// PACT_LINK_SILENCE_MS` auto-pauses every engaged pact on that (link, environment).
function pauseUnreachableLinks(db: Database.Database, now: number): PactLinkEvidenceOutcome[] {
  const paused: PactLinkEvidenceOutcome[] = []
  for (const link of distinctEngagedFederatedLinks(db)) {
    const fact = getScanFact(db, link.linkDeviceId, link.environmentId)
    if (
      !fact ||
      fact.outcome !== 'unreachable' ||
      fact.unreachableSince === null ||
      now - fact.unreachableSince < PACT_LINK_SILENCE_MS
    ) {
      continue
    }
    const pacts = db
      .prepare(
        `SELECT * FROM threads WHERE purged_at IS NULL AND pact_state = 'engaged'
         AND pact_paused_at IS NULL AND pact_peer_link_device_id = ?
         AND pact_peer_environment_id = ?`
      )
      .all(link.linkDeviceId, link.environmentId) as ThreadRow[]
    for (const thread of pacts) {
      // S10-21b B17 (D-R138 B-F7): the UPDATE and the ledger insert were two separate
      // auto-commits — a crash between them left `pact_paused_at` set with
      // `pact_pause_reason='counterpart_gone'` and NO `counterpart_unreachable` ledger row, so
      // `latestHostPauseReasonCode` returned the PRIOR code (or null), and
      // `pactsAwaitingUnpause`'s `!==` form admitted it: the next agent restore resumed a pact
      // whose link is still down (the sweep's own resume, gated `===`, could never reach it
      // either). One `BEGIN IMMEDIATE` per thread closes the window.
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(
          `UPDATE threads SET pact_paused_at = datetime('now'), pact_pause_reason = 'counterpart_gone',
             pact_flight_token = pact_flight_token + 1 WHERE id = ?`
        ).run(thread.id)
        insertPactStepRow(db, {
          threadId: thread.id,
          ordinal: 0,
          kind: 'pause',
          actorAgentId: null,
          actorPaneKey: null,
          actorHostId: null,
          messageId: null,
          summary: null,
          turnAfterAgentId: null,
          reasonCode: 'counterpart_unreachable'
        })
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      paused.push(toOutcome(thread))
    }
    if (pacts.length > 0) {
      // Link-scoped audit event (once per link per episode, see file header) — the link id
      // rides `actorHostId`, matching `repointFederatedPactParty`'s own precedent
      // (pact-federated-identity.ts) for carrying a link id through this shared audit shape.
      auditPact(db, {
        agentId: null,
        actorPaneKey: null,
        actorHostId: link.linkDeviceId,
        verb: 'pact_link_auto_pause',
        outcome: 'paused',
        reasonCode: 'counterpart_unreachable'
      })
    }
  }
  return paused
}

// §3.3/errata NB3, corrected by S10-21b B17 (D-R137 F4, D-R138 F3): once a link-evidence-paused
// pact's link has reported non-'unreachable' CONTINUOUSLY for PACT_LINK_RECOVERY_MS, resume it
// automatically. The base implementation anchored on the pause's own ledger age
// (`latestHostPauseAtMs`) — for any pause older than the recovery window (the common case), that
// bound is vacuous and a SINGLE good scan resumed the pact with zero continuity required. Anchor
// on `reachable_since` instead (the NB2-mirror continuity stamp `putScanFact` derives): the fact
// must be non-'unreachable' AND `reachable_since` must be set AND continuous for
// PACT_LINK_RECOVERY_MS.
function resumeRecoveredPacts(db: Database.Database, now: number): PactLinkEvidenceOutcome[] {
  const resumed: PactLinkEvidenceOutcome[] = []
  const candidates = db
    .prepare(
      `SELECT * FROM threads WHERE purged_at IS NULL AND pact_state = 'engaged'
       AND pact_paused_at IS NOT NULL AND pact_pause_reason = 'counterpart_gone'
       AND pact_peer_link_device_id IS NOT NULL AND pact_peer_environment_id IS NOT NULL`
    )
    .all() as ThreadRow[]
  for (const thread of candidates) {
    if (latestHostPauseReasonCode(db, thread.id) !== 'counterpart_unreachable') {
      continue
    }
    const linkDeviceId = thread.pact_peer_link_device_id
    const environmentId = thread.pact_peer_environment_id
    if (linkDeviceId === null || environmentId === null) {
      continue
    }
    const fact = getScanFact(db, linkDeviceId, environmentId)
    if (!fact || fact.outcome === 'unreachable' || fact.reachableSince === null) {
      continue
    }
    if (now - fact.reachableSince < PACT_LINK_RECOVERY_MS) {
      continue
    }
    // S10-21b B17 (D-R138 B-F7): same crash-window fix as the pause pass above — one
    // `BEGIN IMMEDIATE` per thread around the UPDATE + ledger insert.
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `UPDATE threads SET pact_paused_at = NULL, pact_pause_reason = NULL,
           pact_flight_token = pact_flight_token + 1 WHERE id = ?`
      ).run(thread.id)
      insertPactStepRow(db, {
        threadId: thread.id,
        ordinal: 0,
        kind: 'resume',
        actorAgentId: null,
        actorPaneKey: null,
        actorHostId: null,
        messageId: null,
        summary: null,
        turnAfterAgentId: thread.pact_turn_agent_id,
        reasonCode: null
      })
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    resumed.push(toOutcome(thread))
  }
  return resumed
}

export function runPactLinkEvidenceSweep(
  db: Database.Database,
  now: number = Date.now()
): PactLinkEvidenceSweepResult {
  return { paused: pauseUnreachableLinks(db, now), resumed: resumeRecoveredPacts(db, now) }
}
