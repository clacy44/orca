// S10-21b B9c (D-R134 F7/D-R135 F6): the pact's outstanding `resync` ANSWER occupies one slot
// per pact (§2.11) — an existing unsettled row is REPLACED, never appended. Split from
// reply-outbox-store.ts to stay under max-lines.
import type Database from '../../sqlite/sync-database'
import {
  enqueueReplyOutbox,
  type EnqueueReplyOutboxParams,
  type RelayKind
} from './reply-outbox-store'

// One unsettled row per (pact, relay_kind), still 'queued' (never a 'sending' one, which a dial
// may already be reading).
export function findUnsettledPactAnswerOutboxId(
  db: Database.Database,
  pactThreadId: string,
  relayKind: RelayKind
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM peer_reply_outbox
        WHERE pact_thread_id = ? AND relay_kind = ? AND state = 'queued' AND settled_at IS NULL
        LIMIT 1`
    )
    .get(pactThreadId, relayKind) as { id: string } | undefined
  return row?.id ?? null
}

// Replaces (not appends) — guarded `state='queued'`, matching every other coalescing write here.
export function replacePactAnswerPayload(
  db: Database.Database,
  id: string,
  payload: string,
  byteCount: number,
  pactSeq: number,
  pactEra: number
): boolean {
  const result = db
    .prepare(
      `UPDATE peer_reply_outbox SET payload = ?, byte_count = ?, pact_seq = ?, pact_era = ?
        WHERE id = ? AND state = 'queued'`
    )
    .run(payload, byteCount, pactSeq, pactEra, id)
  return result.changes === 1
}

// One call for "coalesce if this relay kind coalesces, else plain enqueue" — keeps the
// coalescing shape out of pact-federated-emit.ts's own step 5.
export function enqueueReplyOutboxCoalesced(
  db: Database.Database,
  coalesce: boolean,
  p: EnqueueReplyOutboxParams
): string {
  const existing =
    coalesce && p.pactThreadId !== undefined && p.relayKind !== undefined
      ? findUnsettledPactAnswerOutboxId(db, p.pactThreadId, p.relayKind)
      : null
  if (
    existing !== null &&
    replacePactAnswerPayload(db, existing, p.payload, p.byteCount, p.pactSeq ?? 0, p.pactEra ?? 0)
  ) {
    return existing
  }
  return enqueueReplyOutbox(db, p)
}
