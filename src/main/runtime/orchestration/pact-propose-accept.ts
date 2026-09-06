// S10-3 pact spec — propose/accept/decline. Split out of pact-lifecycle.ts (pause/resume/
// release) and pact-step.ts (the step ledger writer) per the max-lines ratchet.
import type Database from '../../sqlite/sync-database'
import type { ThreadRow } from './types'
import {
  auditPact,
  insertPactStepRow,
  otherPactParticipant,
  requireAccountablePeer,
  requireNoEngagedPactWithPeer,
  requireCallerNotQuarantined,
  requirePactParticipant,
  requireSensitiveMembership,
  requireThread,
  requireThreadParticipant,
  requireUnclaimedPact,
  type PactActorContext
} from './pact-shared'
import { findRemotePartyByRenderedKey } from './pact-federated-identity'
import { refuseIfLinkCeilingSaturated } from './pact-federated-ledger-ceiling'
import { findBindingsByEnvironment } from './link-binding-store'
import { isPeerLinkQuarantined } from './link-binding-observations-store'
import { OrchestrationError } from './orchestration-error'

export type ProposePactParams = PactActorContext & {
  threadId: string
  peerAgentId: string
  stepsTotal: number | null // null = --open
}

export function proposePact(db: Database.Database, params: ProposePactParams): ThreadRow {
  const thread = requireThread(db, params.threadId)
  requireThreadParticipant(db, thread.id, params.callerAgentId)
  // Verify major (S10-3b): the CALLER's own quarantine refuses propose too — otherwise a
  // quarantined agent mints fresh engaged pacts while every auto-pause guards only old ones.
  requireCallerNotQuarantined(db, params.callerAgentId, thread.id, 'propose')
  const peer = requireAccountablePeer(db, params.callerAgentId, params.peerAgentId)
  requireSensitiveMembership(db, thread, peer.id, peer.display_name)
  requireUnclaimedPact(thread)
  requireNoEngagedPactWithPeer(db, params.callerAgentId, peer.id, peer.display_name)

  db.exec('BEGIN IMMEDIATE')
  try {
    // pact_era + 1 (blocker fix): a fresh era per propose, so idx_pact_step_ordinal's
    // (thread_id, pact_era, ordinal) never collides with a prior, released era's step rows —
    // the ledger keeps them (ruling 2), so pact_ordinal resetting to 0 alone is not enough.
    //
    // S10-21b B6 (design §2.12, errata 6(16) NB4): the emitting side's own reset list, extended
    // to every v42 column a fresh era must inherit no state from — pact_release_at,
    // pact_peer_release_at, pact_turn_in_flight_at, pact_peer_paused_at, pact_local_seq,
    // pact_peer_seq, pact_last_inbound_at, pact_last_resync_at, pact_relay_pending,
    // pact_resync_nonce, pact_resync_nonce_at, pact_repair_attempts. TWO columns are
    // DELIBERATELY EXCLUDED and must never be RESET here:
    //   - pact_flight_token: the settle guard's (§2.8) monotone per-thread counter. Resetting it
    //     on re-propose would let a stale settle from a PRE-re-propose outbox row land on the
    //     new era's state as if it belonged there — reopening N8's stale-settle hole. It IS
    //     incremented below (S10-21b B6b, D-R134 F4 local half) — a propose is itself a
    //     state-changing local commit the settle guard must see.
    //   - pact_pause_epoch: compared, never zeroed, per §6 — it is not this UPDATE's concern.
    // S10-21b B6 (batch-1 review D-R133 F2, binding): pact_peer_* anchors are unconditionally
    // cleared here — WITHOUT this a released federated pact re-proposed LOCALLY on the same
    // thread/row would retain the prior era's stale non-NULL anchor columns, making
    // isFederatedPact() wrongly true for a brand new local pact. Re-populated below, in the
    // SAME transaction, only when `peer.federated` — closing the "half-formed federated pact"
    // window (a propose that resolved a federated peer but left every anchor column NULL,
    // constructible via local RPC at B3..B5 before this commit).
    db.prepare(
      `UPDATE threads SET
         pact_proposer_agent_id = ?, pact_with_agent_id = ?, pact_state = 'proposed',
         pact_steps_total = ?, pact_ordinal = 0, pact_era = pact_era + 1, pact_turn_agent_id = NULL,
         pact_paused_at = NULL, pact_pause_reason = NULL, pact_at = datetime('now'),
         pact_flight_token = pact_flight_token + 1,
         pact_release_at = NULL, pact_peer_release_at = NULL, pact_turn_in_flight_at = NULL,
         pact_peer_paused_at = NULL, pact_local_seq = 0, pact_peer_seq = 0,
         pact_last_inbound_at = NULL, pact_last_resync_at = NULL, pact_relay_pending = NULL,
         pact_resync_nonce = NULL, pact_resync_nonce_at = NULL, pact_repair_attempts = 0,
         pact_peer_agent_id = NULL, pact_peer_link_device_id = NULL,
         pact_peer_environment_id = NULL, pact_peer_key_fingerprint = NULL
       WHERE id = ?`
    ).run(params.callerAgentId, peer.id, params.stepsTotal, thread.id)
    if (peer.federated) {
      const remote = findRemotePartyByRenderedKey(db, peer.id)
      if (!remote) {
        throw new Error(
          `internal error: federated peer ${peer.id} resolved by requireAccountablePeer but its remote_agents row vanished mid-transaction`
        )
      }
      // S10-21b B14 (design §4.6(a), errata NB7): the per-link ceiling, mirrored here for the
      // LOCAL propose direction (inbound propose has its own call, pact-federated-propose-apply.ts).
      refuseIfLinkCeilingSaturated(
        db,
        remote.environment_id,
        remote.display_name,
        remote.environment_id
      )
      // R18.4(b)'s candidate lookup (link-binding-store.ts): CONFIRMED, unrevoked bindings for
      // this environment — the same two clauses findBindingCandidateByKeyFingerprint applies.
      // No binding yet (the environment was found by probe, never link-paired) leaves the two
      // link-scoped anchors NULL; pact_peer_agent_id/pact_peer_environment_id are still set, so
      // isFederatedPact() is correctly true and the emit path (pact-federated-emit.ts) refuses
      // loudly rather than silently treating the pact as local — unchanged below.
      //
      // S10-21b B6b (D-R134 F11 / D-R135 A10/B-F8, batch-2 REJECT): with >=2 confirmed rows the
      // prior unordered `.find()` picked SQLite's unspecified row order and could anchor to a
      // quarantined/dead route. Deterministic selection: exclude a locally quarantined link,
      // then order by boundPairingRevision DESC (tie-broken by linkDeviceId) so the same input
      // always picks the same row. Not routed through getRoutableLinkBinding
      // (link-binding-routable.ts): that helper needs OrcaRuntimeService for its registry/
      // environment-file reads, which proposePact's raw-db signature does not carry and the
      // brief's own "minimal, one small hunk" constraint rules out threading through here — this
      // is D-R135's own stated fallback ("failing that, order by bound_pairing_revision DESC and
      // exclude quarantined links").
      const candidates = findBindingsByEnvironment(db, remote.environment_id).filter(
        (b) => b.state === 'confirmed' && b.revokedAt === null
      )
      const routable = candidates
        .filter((b) => !isPeerLinkQuarantined(db, b.linkDeviceId))
        .sort((a, b) =>
          b.boundPairingRevision !== a.boundPairingRevision
            ? b.boundPairingRevision - a.boundPairingRevision
            : a.linkDeviceId.localeCompare(b.linkDeviceId)
        )
      // Candidates existed but every one is quarantined — refuse rather than anchor to a known-
      // bad route. Zero candidates at all is the pre-existing "never link-paired" case (comment
      // above) and stays silent/deferred, unchanged.
      if (candidates.length > 0 && routable.length === 0) {
        throw new OrchestrationError(
          'pact_no_route',
          `Refused: every link binding for ${remote.environment_id} is quarantined; no route to propose this pact over.`,
          { nextSteps: ['orca agents link --show'] }
        )
      }
      const binding = routable[0] ?? null
      db.prepare(
        `UPDATE threads SET
           pact_peer_agent_id = ?, pact_peer_environment_id = ?,
           pact_peer_link_device_id = ?, pact_peer_key_fingerprint = ?
         WHERE id = ?`
      ).run(
        remote.remote_agent_id,
        remote.environment_id,
        binding?.linkDeviceId ?? null,
        binding?.peerKeyFingerprint ?? remote.peer_fingerprint,
        thread.id
      )
    }
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: 0,
      kind: 'propose',
      actorAgentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      messageId: null,
      summary: null,
      turnAfterAgentId: null,
      reasonCode: null
    })
    auditPact(db, {
      agentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      verb: 'pact_propose',
      outcome: 'proposed'
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return requireThread(db, thread.id)
}

export type AcceptPactParams = PactActorContext & { threadId: string }

// Turn moves to the proposer first (RPCS §).
export function acceptPact(db: Database.Database, params: AcceptPactParams): ThreadRow {
  const thread = requireThread(db, params.threadId)
  requireProposedTo(thread, params.callerAgentId)
  requireCallerNotQuarantined(db, params.callerAgentId, thread.id, 'accept')

  db.exec('BEGIN IMMEDIATE')
  try {
    // D-R134 F4 local half: pact_flight_token bumped alongside the state/turn write it guards.
    db.prepare(
      `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?, pact_at = datetime('now'),
         pact_flight_token = pact_flight_token + 1
       WHERE id = ?`
    ).run(thread.pact_proposer_agent_id, thread.id)
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: 0,
      kind: 'accept',
      actorAgentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      messageId: null,
      summary: null,
      turnAfterAgentId: thread.pact_proposer_agent_id,
      reasonCode: null
    })
    auditPact(db, {
      agentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      verb: 'pact_accept',
      outcome: 'engaged'
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return requireThread(db, thread.id)
}

export type DeclinePactParams = PactActorContext & { threadId: string; reasonCode: string | null }

export function declinePact(db: Database.Database, params: DeclinePactParams): ThreadRow {
  const thread = requireThread(db, params.threadId)
  requireProposedTo(thread, params.callerAgentId)
  return releasePactRow(db, thread, params, 'decline')
}

// Authority: pact_with_agent_id only, and only while still 'proposed' (accept/decline answer
// the SAME proposal; a re-decline after accept goes through releasePact instead).
function requireProposedTo(thread: ThreadRow, callerAgentId: string): void {
  if (thread.pact_state !== 'proposed' || thread.pact_with_agent_id !== callerAgentId) {
    throw new OrchestrationError(
      'not_a_participant',
      `Refused: there is no pending pact proposal to you on ${thread.id}.`,
      { nextSteps: [`orca agents pact --show ${thread.id}`] }
    )
  }
}

// Shared by declinePact and releasePact (pact-lifecycle.ts) — both move pact_state to
// 'released' and clear the turn; the only difference is the ledger kind / audit verb.
// S10-21b B12b: `summary` explicit (was hardcoded null) — releasePact's own caller sanitizes
// `--evidence` into it; declinePact still passes null (decline never carries evidence, SCOPE).
export function releasePactRow(
  db: Database.Database,
  thread: ThreadRow,
  params: PactActorContext & { reasonCode: string | null; summary?: string | null },
  kind: 'decline' | 'release'
): ThreadRow {
  db.exec('BEGIN IMMEDIATE')
  try {
    // D-R134 F4 local half: pact_flight_token bumped alongside the state/turn write it guards.
    // S10-21b B14 (design §4.6(b)): `pact_release_at` stamped here — the retention-based purge
    // exemption (`trg_pact_steps_no_delete`) keys on it, and it was never set anywhere before
    // this fix (a `decline` leaves it NULL too, matching a decline never having been released).
    db.prepare(
      `UPDATE threads SET pact_state = 'released', pact_turn_agent_id = NULL,
         pact_paused_at = NULL, pact_pause_reason = NULL, pact_at = datetime('now'),
         pact_flight_token = pact_flight_token + 1,
         pact_release_at = CASE WHEN ? = 'release' THEN datetime('now') ELSE pact_release_at END
       WHERE id = ?`
    ).run(kind, thread.id)
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: 0,
      kind,
      actorAgentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      messageId: null,
      summary: params.summary ?? null,
      turnAfterAgentId: null,
      reasonCode: params.reasonCode
    })
    auditPact(db, {
      agentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      verb: `pact_${kind}`,
      outcome: 'released',
      reasonCode: params.reasonCode
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return requireThread(db, thread.id)
}

// Re-exported for pact-lifecycle.ts's releasePact (K11: either participant, any state).
export { requirePactParticipant, otherPactParticipant }
