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
// N6: also refreshes local_message_id, pact_state and pact_flight_token — re-read from the
// thread exactly as enqueueReplyOutbox stamps them on a fresh insert — so settle's
// markPeerRelayAccepted stamps the NEW message and the staleness guard compares the CURRENT
// token, never the superseded row's.
// B15 (§2.7 N10/T32): `relayKind`, when given, is ALSO refreshed — cross-kind coalescing (a
// queued pact_pause replaced in place by a pact_resume) must turn the row INTO the new kind,
// never leave it labelled as the superseded one.
export function replacePactAnswerPayload(
  db: Database.Database,
  id: string,
  localMessageId: string,
  payload: string,
  byteCount: number,
  pactSeq: number,
  pactEra: number,
  pactThreadId: string,
  relayKind?: RelayKind
): boolean {
  const thread = db
    .prepare('SELECT pact_state, pact_flight_token FROM threads WHERE id = ?')
    .get(pactThreadId) as { pact_state: string | null; pact_flight_token: number } | undefined
  const result = db
    .prepare(
      `UPDATE peer_reply_outbox SET local_message_id = ?, payload = ?, byte_count = ?,
         pact_seq = ?, pact_era = ?, pact_state = ?, pact_flight_token = ?,
         relay_kind = COALESCE(?, relay_kind)
        WHERE id = ? AND state = 'queued'`
    )
    .run(
      localMessageId,
      payload,
      byteCount,
      pactSeq,
      pactEra,
      thread?.pact_state ?? null,
      thread?.pact_flight_token ?? null,
      relayKind ?? null,
      id
    )
  return result.changes === 1
}

// B15 (§2.7 N10): the pause/resume cross-kind lookup — one unsettled row across BOTH
// `pact_pause`/`pact_resume` for this pact, still `queued`.
export function findUnsettledPactAnswerOutboxIdAcrossKinds(
  db: Database.Database,
  pactThreadId: string,
  relayKinds: readonly RelayKind[]
): string | null {
  const placeholders = relayKinds.map(() => '?').join(',')
  const row = db
    .prepare(
      `SELECT id FROM peer_reply_outbox
        WHERE pact_thread_id = ? AND relay_kind IN (${placeholders}) AND state = 'queued'
          AND settled_at IS NULL
        LIMIT 1`
    )
    .get(pactThreadId, ...relayKinds) as { id: string } | undefined
  return row?.id ?? null
}

// B15 (§2.7 N10, T32): a fresh pause/resume call REPLACES an already-queued item of EITHER
// kind for this pact, carrying the current absolute state (verb, payload) at call time —
// never leaves two outstanding items, and never touches a claimed 'sending' row.
export function enqueueReplyOutboxCoalescedAcrossKinds(
  db: Database.Database,
  relayKinds: readonly RelayKind[],
  p: EnqueueReplyOutboxParams
): string {
  const existing =
    p.pactThreadId !== undefined
      ? findUnsettledPactAnswerOutboxIdAcrossKinds(db, p.pactThreadId, relayKinds)
      : null
  if (
    existing !== null &&
    p.pactThreadId !== undefined &&
    replacePactAnswerPayload(
      db,
      existing,
      p.localMessageId,
      p.payload,
      p.byteCount,
      p.pactSeq ?? 0,
      p.pactEra ?? 0,
      p.pactThreadId,
      p.relayKind
    )
  ) {
    return existing
  }
  // S10-21b B21 (D-D3-A item 1, R2): capExempt ONLY when relayKinds is exactly the
  // pause/resume pair this coalescer bounds to <= 1 queued row per pact — asserted, never
  // inferred from the caller, so a future cross-kind coalesce call does not silently inherit
  // the exemption.
  // S10-21b B21b (D-R142 N4): ALSO require the ROW's OWN kind (p.relayKind) to be pause or
  // resume — the coalesce SET alone (relayKinds) says what this call coalesces ACROSS, not what
  // this particular row IS; they coincide today only because the sole caller
  // (pause-resume-emit.ts) is typed `'pause'|'resume'`, but asserting the SET alone would exempt
  // a differently-kinded row (e.g. a future pact_step call reusing this coalescer) that the
  // per-pact/per-link bounds were never sized for.
  const capExempt =
    relayKinds.length === 2 &&
    relayKinds.includes('pact_pause') &&
    relayKinds.includes('pact_resume') &&
    (p.relayKind === 'pact_pause' || p.relayKind === 'pact_resume')
  return enqueueReplyOutbox(db, { ...p, capExempt })
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
    p.pactThreadId !== undefined &&
    replacePactAnswerPayload(
      db,
      existing,
      p.localMessageId,
      p.payload,
      p.byteCount,
      p.pactSeq ?? 0,
      p.pactEra ?? 0,
      p.pactThreadId
    )
  ) {
    return existing
  }
  return enqueueReplyOutbox(db, p)
}

// S10-21b B17 (D-R138 B-F1): the replace-vs-insert PRE-CHECK `enqueueFederatedPactVerbWithin`
// runs before its own seq bump (a coalesced replacement must not consume a new wire seq) —
// mirrors the lookup each `enqueueReplyOutboxCoalesced*` call above does internally, so the
// same row is found deterministically within one transaction. Split out here (not left inline
// in pact-federated-emit-steps.ts) to keep that file under the max-lines ratchet.
export function resolveCoalesceTarget(
  db: Database.Database,
  threadId: string,
  verb: string,
  relayKind: RelayKind,
  coalesceAcrossRelayKinds?: readonly RelayKind[]
): string | null {
  if (coalesceAcrossRelayKinds) {
    return findUnsettledPactAnswerOutboxIdAcrossKinds(db, threadId, coalesceAcrossRelayKinds)
  }
  return verb === 'resync' ? findUnsettledPactAnswerOutboxId(db, threadId, relayKind) : null
}
