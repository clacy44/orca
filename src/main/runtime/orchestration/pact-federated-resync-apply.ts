// S10-21b B9 (design §2.5's `resync_request`/`resync` prose, §2.1 field ownership) — the APPLY
// half of the two repair verbs; the fence/disposition/nonce-mint machinery both of these lean on
// lives in pact-federated-repair.ts (max-lines split). Neither verb passes through gate 14's
// strict fence (§2.5: "the wire dedupe alone is sufficient for it" — gate 8, upstream of both
// functions below, already supplies that). `pact_ordinal` is NEVER touched here (INV-P-021).
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import { auditPact, requireThread } from './pact-shared'
import { enqueueFederatedPactVerb } from './pact-federated-emit'
import { isResyncNonceLive } from './pact-federated-repair'
import { recordPactAppliedId, type ApplyInboundPactVerbArgs } from './pact-federated-inbound-gates'
import type { InboundPactWake } from './pact-federated-inbound-wake'
import type { ThreadRow } from './thread-directory-types'

type ResyncApplyResult = {
  accepted: true
  messageId: string
  threadId: string
  wake: InboundPactWake
}

// Recomputed from the append-only ledger, never a stored counter — extending INV-P-021's own
// recompute-not-wire-store philosophy to the pause epoch THIS host reports about ITSELF (there is
// no dedicated "our own pause epoch" column; `pact_pause_epoch` per §2.1's field table is "their
// pause"'s tracker, i.e. what THIS host last learned about the PEER). Every LOCAL pause/resume
// transition on the current era appends a pact_steps row with actor_is_remote = 0
// (pact-lifecycle.ts's pausePact/resumePact); counting them gives a monotone toggle counter whose
// PARITY is the current state, because pausePact/resumePact each refuse when the pact is already
// in the state they would produce (pause/resume strictly alternate, starting from unpaused).
function localPauseEpoch(db: Database.Database, thread: ThreadRow): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM pact_steps
        WHERE thread_id = ? AND pact_era = ? AND actor_is_remote = 0 AND kind IN ('pause','resume')`
    )
    .get(thread.id, thread.pact_era) as { n: number }
  return row.n
}

// `resync_request` — the ask. This host is not the one that detected a gap (it is the party
// being ASKED), so it mints no nonce of its own and never touches `pact_resync_nonce`; it simply
// answers immediately with its own absolute state, echoing the request's nonce.
export function applyInboundResyncRequestVerb(
  db: Database.Database,
  thread: ThreadRow,
  args: ApplyInboundPactVerbArgs
): ResyncApplyResult {
  const nonce = args.pact.resyncRequest?.nonce
  if (nonce === undefined) {
    throw new OrchestrationError(
      'invalid_argument',
      'The relayed resync_request is missing resyncRequest.nonce.',
      { reasonCode: 'malformed_relay_id' }
    )
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    recordPactAppliedId(db, thread.id, args.messageId, 'resync_request')
    db.prepare(`UPDATE threads SET pact_last_inbound_at = datetime('now') WHERE id = ?`).run(
      thread.id
    )
    auditPact(db, {
      agentId: null,
      actorPaneKey: null,
      actorHostId: args.pairedDeviceId,
      verb: 'pact_resync_request',
      outcome: 'received'
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  const fresh = requireThread(db, thread.id)
  enqueueFederatedPactVerb(db, null, thread.id, 'resync', {
    actorAgentId: null,
    actorPaneKey: null,
    actorHostId: null,
    runId: 'host',
    resync: {
      nonce,
      localSeq: fresh.pact_local_seq,
      ordinal: fresh.pact_ordinal,
      state: (fresh.pact_state ?? 'released') as 'proposed' | 'engaged' | 'released',
      turnHeldBySender:
        fresh.pact_turn_agent_id !== null && !fresh.pact_turn_agent_id.startsWith('remote:'),
      pauseEpoch: localPauseEpoch(db, fresh),
      senderReleased: fresh.pact_state === 'released'
    }
  })
  return { accepted: true, messageId: args.messageId, threadId: thread.id, wake: { kind: 'none' } }
}

// `resync` — the answer. Applied only when every §2.5 gate holds; dropped otherwise (silently
// for stale/superseded/expired, audited for a nonce this host never issued at all).
export function applyInboundResyncVerb(
  db: Database.Database,
  thread: ThreadRow,
  args: ApplyInboundPactVerbArgs
): ResyncApplyResult {
  const resync = args.pact.resync
  if (resync === undefined) {
    throw new OrchestrationError('invalid_argument', 'The relayed resync is missing its payload.', {
      reasonCode: 'malformed_relay_id'
    })
  }
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    recordPactAppliedId(db, thread.id, args.messageId, 'resync')
    const fresh = requireThread(db, thread.id)
    const live = isResyncNonceLive(fresh, now)
    if (!live || fresh.pact_resync_nonce !== resync.nonce) {
      // Never issued (pact_resync_nonce is NULL — no ask is on record at all) is audited; a
      // stale, superseded, or expired nonce is dropped silently (§2.5).
      if (fresh.pact_resync_nonce === null) {
        auditPact(db, {
          agentId: null,
          actorPaneKey: null,
          actorHostId: args.pairedDeviceId,
          verb: 'pact_resync',
          outcome: 'dropped_unknown_nonce'
        })
      }
      db.exec('COMMIT')
      return {
        accepted: true,
        messageId: args.messageId,
        threadId: thread.id,
        wake: { kind: 'none' }
      }
    }
    if (resync.localSeq <= fresh.pact_peer_seq) {
      // A replayed/stale answer to a since-superseded ask — dropped silently.
      db.exec('COMMIT')
      return {
        accepted: true,
        messageId: args.messageId,
        threadId: thread.id,
        wake: { kind: 'none' }
      }
    }
    let peerPausedAt = fresh.pact_peer_paused_at
    let pauseEpoch = fresh.pact_pause_epoch
    if (resync.pauseEpoch > fresh.pact_pause_epoch) {
      // Monotone epoch, not a plain boolean (N3 limb 2): parity encodes the state because
      // pause/resume strictly alternate (see localPauseEpoch above) — odd = paused.
      peerPausedAt = resync.pauseEpoch % 2 === 1 ? new Date(now).toISOString() : null
      pauseEpoch = resync.pauseEpoch
    }
    const releaseJoin = resync.senderReleased ? 1 : 0
    db.prepare(
      `UPDATE threads SET
         pact_peer_seq = ?, pact_peer_paused_at = ?, pact_pause_epoch = ?,
         pact_peer_release_at = CASE WHEN ? = 1 THEN COALESCE(pact_peer_release_at, datetime('now')) ELSE pact_peer_release_at END,
         pact_state = CASE WHEN ? = 1 THEN 'released' ELSE pact_state END,
         pact_resync_nonce = NULL, pact_resync_nonce_at = NULL, pact_repair_attempts = 0,
         pact_last_resync_at = datetime('now'), pact_last_inbound_at = datetime('now')
       WHERE id = ?`
    ).run(resync.localSeq, peerPausedAt, pauseEpoch, releaseJoin, releaseJoin, thread.id)
    auditPact(db, {
      agentId: null,
      actorPaneKey: null,
      actorHostId: args.pairedDeviceId,
      verb: 'pact_resync',
      outcome: 'applied'
    })
    db.exec('COMMIT')
    return {
      accepted: true,
      messageId: args.messageId,
      threadId: thread.id,
      wake: { kind: 'none' }
    }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
