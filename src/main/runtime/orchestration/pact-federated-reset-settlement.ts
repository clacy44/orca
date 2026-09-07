// S10-21b B14 (design §4.5, Addendum 6(5), [v3.1, Addendum 6(15), closes NA5]) — `resetAll`'s
// federated-pact settlement: every live federated pact is released LOCALLY (one host `release`
// ledger row, `reason_code='local_reset'`), its anchors cleared, and — since neither the peer's
// own staleness deadline nor a later `pact_no_pact` exists any more to surface the reset to it —
// ONE reserved `release` relay item is queued to that pact's peer. The corrected v3.1 ordering
// (closes D-R90/NA5): this module's `settleLiveFederatedPactsForReset` runs FIRST (before
// `resetAll`'s ordinary deletes); its return value is held by the caller until AFTER
// `DELETE FROM peer_reply_outbox` runs; only then does `enqueueReservedReleasesAfterReset` (this
// module) insert into the now-empty table — inserting before the delete would just have the
// delete remove the row it inserted (v3 as drafted's bug).
//
// S10-21b B7c (21b-Q3): a pending pact's release relay now goes through
// `enqueueFederatedPactVerbWithin` (step 3, below), so it gets a REAL messages row (the settle
// contract's local_message_id can never dangle) instead of a hand-built envelope aimed at a
// message that was never inserted. That primitive's own guards (isFederatedPact, the peer
// anchor columns, the live binding) require the thread to still read as federated — so a
// pending row's anchors are left UNTOUCHED by `settleLiveFederatedPactsForReset` and are only
// cleared by `enqueueReservedReleasesAfterReset`, AFTER the primitive's own call. A pact with no
// relayable peer (never linked, or the link's binding is already gone) has no such call to make
// and is released fully, right here, exactly as before.
import type Database from '../../sqlite/sync-database'
import { insertPactStepRow } from './pact-shared'
import { getPeerLinkBinding } from './link-binding-store'
import { enqueueFederatedPactVerbWithin } from './pact-federated-emit'

type LiveFederatedPactRow = {
  id: string
  pact_era: number
  pact_local_seq: number
  pact_peer_agent_id: string
  pact_peer_link_device_id: string | null
  pact_peer_environment_id: string | null
  pact_peer_thread_id: string | null
  pact_proposer_agent_id: string | null
  pact_with_agent_id: string | null
}

// `pact_steps`'s own CHECK (`actor_agent_id IS NOT NULL OR kind IN ('pause','resume')`) does
// NOT exempt 'release' — a host-authored release row still needs a real actor id. The local
// (non-`remote:`-prefixed) party is the closest honest attribution for a reset-driven release;
// `reason_code='local_reset'` is what actually carries "this was the host, not a participant
// call" (the same declared-deviation shape §2.6(c) already uses for its own host rows).
function localPartyOf(row: LiveFederatedPactRow): string {
  const proposer = row.pact_proposer_agent_id ?? ''
  const withAgent = row.pact_with_agent_id ?? ''
  return proposer.startsWith('remote:') ? withAgent : proposer
}

export type PendingReservedRelease = {
  threadId: string
  actorAgentId: string
}

// D-R137 F9 / D-R138 §E residual: the local-release shape (ledger row + `pact_release_at`
// stamp), factored out so step 3's message-gate-refusal fallback (below) can reuse it exactly —
// a message gate refusing the relay must still leave the pact locally released and purgeable,
// never `pact_state='released'` with `pact_release_at` NULL forever (the retention trigger's arm
// requires it non-null).
function releasePactLocallyForReset(
  db: Database.Database,
  threadId: string,
  actorAgentId: string
): void {
  const row = db.prepare(`SELECT pact_local_seq FROM threads WHERE id = ?`).get(threadId) as {
    pact_local_seq: number
  }
  const nextSeq = row.pact_local_seq + 1
  insertPactStepRow(db, {
    threadId,
    ordinal: 0,
    kind: 'release',
    actorAgentId,
    actorPaneKey: null,
    actorHostId: null,
    messageId: null,
    summary: null,
    turnAfterAgentId: null,
    reasonCode: 'local_reset'
  })
  db.prepare(
    `UPDATE threads SET
       pact_state = 'released', pact_turn_agent_id = NULL, pact_paused_at = NULL,
       pact_pause_reason = NULL, pact_at = datetime('now'), pact_release_at = datetime('now'),
       pact_flight_token = pact_flight_token + 1, pact_turn_in_flight_at = NULL,
       pact_relay_pending = NULL, pact_resync_nonce = NULL, pact_resync_nonce_at = NULL,
       pact_repair_attempts = 0, pact_local_seq = ?,
       pact_peer_agent_id = NULL, pact_peer_link_device_id = NULL,
       pact_peer_environment_id = NULL, pact_peer_key_fingerprint = NULL
     WHERE id = ?`
  ).run(nextSeq, threadId)
}

// Step 1 of §4.5's corrected ordering. A pact with no relayable peer is released fully here
// (unchanged from before B7c). A pact WITH one is left untouched — its full release (state,
// ledger row, local_seq bump) now happens inside step 3's `enqueueFederatedPactVerbWithin`
// call, which needs the thread to still read as federated. Runs inside the caller's own
// transaction (no BEGIN/COMMIT of its own — `resetAll` holds the one transaction this whole
// sequence shares).
export function settleLiveFederatedPactsForReset(db: Database.Database): PendingReservedRelease[] {
  const rows = db
    .prepare(
      `SELECT id, pact_era, pact_local_seq, pact_peer_agent_id, pact_peer_link_device_id,
              pact_peer_environment_id, pact_peer_thread_id, pact_proposer_agent_id,
              pact_with_agent_id
         FROM threads
        WHERE purged_at IS NULL AND pact_peer_agent_id IS NOT NULL
          AND pact_state IN ('proposed', 'engaged')`
    )
    .all() as LiveFederatedPactRow[]

  const pending: PendingReservedRelease[] = []
  for (const row of rows) {
    const canRelay =
      row.pact_peer_link_device_id !== null &&
      row.pact_peer_environment_id !== null &&
      getPeerLinkBinding(db, row.pact_peer_link_device_id) !== null
    if (canRelay) {
      pending.push({ threadId: row.id, actorAgentId: localPartyOf(row) })
      continue
    }
    // No relay is possible (never linked, or the link's binding is already gone) — release
    // locally, right here, exactly as before B7c.
    releasePactLocallyForReset(db, row.id, localPartyOf(row))
  }
  return pending
}

// Step 3 of §4.5's corrected ordering — called ONLY after the caller's own
// `DELETE FROM peer_reply_outbox`/`DELETE FROM messages` have run, in the SAME transaction (the
// primitive's own message insert therefore lands in a table the delete already passed over).
// `Within` still reads each pending thread as federated (its anchors were left untouched in
// step 1) and does the actual release: state/turn/pause transition, the ledger row, the
// local_seq bump, and the outbox row against a REAL message row. The follow-up UPDATE below
// then does resetAll's OWN cleanup — the columns `Within`'s release branch does not know about
// — and unconditionally re-asserts the released shape (a defensive no-op on the ordinary path;
// it is what still leaves the pact released if the primitive's message gate ever refused).
export function enqueueReservedReleasesAfterReset(
  db: Database.Database,
  pending: readonly PendingReservedRelease[]
): void {
  for (const item of pending) {
    const result = enqueueFederatedPactVerbWithin(db, item.threadId, 'release', {
      actorAgentId: item.actorAgentId,
      actorPaneKey: null,
      actorHostId: null,
      runId: 'reset',
      reasonCode: 'local_reset'
    })
    // D-R137 F9: a message-gate refusal here (step 1 of the primitive) never runs the
    // primitive's own release-branch UPDATE — no ledger row, no `pact_release_at`. The
    // follow-up UPDATE below re-asserted `pact_state='released'` regardless, leaving the pact
    // unpurgeable forever (the retention trigger's arm requires `pact_release_at IS NOT NULL`).
    // Fall back to the exact same local release step 1 uses instead of that follow-up UPDATE.
    if (result.outcome === 'refused') {
      releasePactLocallyForReset(db, item.threadId, item.actorAgentId)
      continue
    }
    // resetAll's own reset-specific cleanup, plus an unconditional re-assert of the released
    // shape — clears `pact_relay_pending` even if the call above just set it (a reset always
    // fully clears coordination-bus state; that token has no drainer for 'release' regardless).
    // `pact_release_at` is stamped here too (idempotent alongside `Within`'s own stamp on the
    // non-refused path) so the refusal fallback above is never the only writer of it.
    db.prepare(
      `UPDATE threads SET
         pact_state = 'released', pact_turn_agent_id = NULL, pact_paused_at = NULL,
         pact_pause_reason = NULL, pact_at = datetime('now'), pact_turn_in_flight_at = NULL,
         pact_release_at = COALESCE(pact_release_at, datetime('now')),
         pact_relay_pending = NULL, pact_resync_nonce = NULL, pact_resync_nonce_at = NULL,
         pact_repair_attempts = 0, pact_peer_agent_id = NULL, pact_peer_link_device_id = NULL,
         pact_peer_environment_id = NULL, pact_peer_key_fingerprint = NULL
       WHERE id = ?`
    ).run(item.threadId)
  }
}
