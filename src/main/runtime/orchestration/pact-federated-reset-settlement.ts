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
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { insertPactStepRow } from './pact-shared'
import { getPeerLinkBinding } from './link-binding-store'
import { enqueueReplyOutbox } from './reply-outbox-store'

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
  linkDeviceId: string
  environmentId: string
  peerAgentId: string
  peerThreadId: string | null
  era: number
  seq: number
}

// Step 1 of §4.5's corrected ordering — releases every live federated pact locally and RECORDS
// which peers need the reserved release, without touching `peer_reply_outbox` at all (that
// happens later, after the caller's own deletes). Runs inside the caller's own transaction (no
// BEGIN/COMMIT of its own — `resetAll` holds the one transaction this whole sequence shares).
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
    const nextSeq = row.pact_local_seq + 1
    // Attributed to the local party (see localPartyOf's comment) — `reason_code='local_reset'`
    // is what actually marks this as the host's own reset act, not a participant's release call.
    insertPactStepRow(db, {
      threadId: row.id,
      ordinal: 0,
      kind: 'release',
      actorAgentId: localPartyOf(row),
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
    ).run(nextSeq, row.id)

    if (row.pact_peer_link_device_id && row.pact_peer_environment_id) {
      pending.push({
        threadId: row.id,
        linkDeviceId: row.pact_peer_link_device_id,
        environmentId: row.pact_peer_environment_id,
        peerAgentId: row.pact_peer_agent_id,
        peerThreadId: row.pact_peer_thread_id,
        era: row.pact_era,
        seq: nextSeq
      })
    }
  }
  return pending
}

// Step 3 of §4.5's corrected ordering — called ONLY after the caller's own
// `DELETE FROM peer_reply_outbox` has run, in the SAME transaction. A link with no binding row
// left (already unpaired) is silently skipped — there is no route left to relay a release over,
// and the pact is already released locally regardless.
export function enqueueReservedReleasesAfterReset(
  db: Database.Database,
  pending: readonly PendingReservedRelease[]
): void {
  for (const item of pending) {
    const binding = getPeerLinkBinding(db, item.linkDeviceId)
    if (!binding) {
      continue
    }
    const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const envelope = {
      toAgentId: item.peerAgentId,
      messageId,
      threadId: item.threadId,
      subject: 'pact release',
      type: 'status',
      priority: 'normal',
      pact: { verb: 'release', seq: item.seq, era: item.era }
    }
    const payload = JSON.stringify(envelope)
    enqueueReplyOutbox(db, {
      localMessageId: messageId,
      linkDeviceId: item.linkDeviceId,
      environmentId: item.environmentId,
      boundPairingRevision: binding.boundPairingRevision,
      peerCredentialFp: binding.peerCredentialFp,
      peerKeyFingerprint: binding.peerKeyFingerprint,
      inReplyToMessageId: messageId,
      peerAgentId: item.peerAgentId,
      peerThreadId: item.peerThreadId,
      localThreadId: item.threadId,
      noticeRunId: null,
      noticePaneKey: null,
      payload,
      byteCount: Buffer.byteLength(payload, 'utf8'),
      createdAt: Date.now(),
      reserved: true,
      pactThreadId: item.threadId,
      pactSeq: item.seq,
      pactEra: item.era,
      relayKind: 'pact_release'
    })
  }
}
