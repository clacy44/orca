// Split out of pact-federated-emit.ts (max-lines ratchet, S10-21b B7c) — the wire-verb
// vocabulary (the design §2.3/§2.4/§2.11 constants) plus the `Within` form's full body (steps
// 1-5). pact-federated-emit.ts imports and re-exports these so every existing importer of that
// module is unaffected; behaviour is unchanged from before the split.
import type Database from '../../sqlite/sync-database'
import type { GateVerdict } from '../../../shared/message-body-gate'
import type { MessageRow } from './types'
import type { PactStepKind } from './pact-types'
import { insertGatedMessage } from './message-gate-writer'
import { bumpThreadOnMessage } from './thread-directory'
import {
  applyPactPauseResumeState,
  insertPactStepRow,
  otherPactParticipant,
  pactWaiterHandle,
  requireThread
} from './pact-shared'
import { isFederatedPact } from './pact-federated-identity'
import type { RelayKind } from './reply-outbox-store'
import {
  enqueueReplyOutboxCoalesced,
  enqueueReplyOutboxCoalescedAcrossKinds,
  resolveCoalesceTarget
} from './reply-outbox-pact-answer-coalesce'
import { getPeerLinkBinding, LinkBindingCapError } from './link-binding-store'
import { buildPactWirePayload } from './pact-federated-wire-envelope'

export type FederatedPactVerb =
  | 'propose'
  | 'accept'
  | 'decline'
  | 'step'
  | 'pause'
  | 'resume'
  | 'release'
  | 'rebind_party'
  | 'resync'
  | 'resync_request'
  | 'gap_notice'

// §2.4's wire vocabulary, keyed by verb (RelayKind mirrors payload_kind 1:1, chair answer 2:
// `relay_kind = 'pact_' + verb`).
export const PACT_VERB_RELAY_KIND: Record<FederatedPactVerb, RelayKind> = {
  propose: 'pact_propose',
  accept: 'pact_accept',
  decline: 'pact_decline',
  step: 'pact_step',
  pause: 'pact_pause',
  resume: 'pact_resume',
  release: 'pact_release',
  rebind_party: 'pact_rebind_party',
  resync: 'pact_resync',
  resync_request: 'pact_resync_request',
  gap_notice: 'pact_gap_notice'
}

// §2.5: the four no-ledger verbs never call insertPactStepRow.
export const PACT_NO_LEDGER_VERBS: ReadonlySet<FederatedPactVerb> = new Set([
  'resync',
  'resync_request',
  'rebind_party',
  'gap_notice'
])

// §2.11: admitted past the ordinary REPLY_OUTBOX_PER_LINK_CAP, up to +PACT_RESERVED_HEADROOM.
// B15: pause/resume join the reserved set (§2.7 side effects, same headroom as release).
export const PACT_RESERVED_VERBS: ReadonlySet<FederatedPactVerb> = new Set([
  'release',
  'rebind_party',
  'resync',
  'resync_request',
  'gap_notice',
  'pause',
  'resume'
])

// §2.2/§2.1: the in-flight guard applies to a verb that hands the turn to the peer.
// S10-21b B6c wires `accept` in beside `step` for the in-flight MARKER and the outbox's
// `pact_turn_after` field — settle still re-applies that same value once the peer acks. Unlike
// `step`, accept's own `pact_turn_agent_id` write is NOT deferred (see the verb-specific special
// case below): `trg_pact_turn_membership` (db.ts) requires a valid turn holder the instant
// `pact_state` becomes 'engaged', which step never triggers since it never touches pact_state.
export const PACT_TURN_CONSUMING_VERBS: ReadonlySet<FederatedPactVerb> = new Set(['step', 'accept'])

// §2.11: `threads.pact_relay_pending` — DEVIATION (B9c, D-R134 F7/D-R135 F6): the design's
// closed four-value vocabulary ('release'|'rebind'|'resync_request'|'gap_notice') has no slot
// for the resync ANSWER, whose own `LinkBindingCapError` used to propagate AFTER
// recordPactAppliedId already committed — the peer's retry then deduped and the answer was lost
// for good. A fifth token, 'resync', closes that hole the same way the other three do; nothing
// drains it yet (matching 'release'/'resync_request', neither of which has a drainer landed
// either — future work, not this commit's scope).
export type PactRelayPendingToken = 'release' | 'rebind' | 'resync_request' | 'resync'
export const PACT_RELAY_PENDING_TOKEN: Partial<Record<FederatedPactVerb, PactRelayPendingToken>> = {
  release: 'release',
  rebind_party: 'rebind',
  resync_request: 'resync_request',
  resync: 'resync'
}

export type FederatedPactResyncPayload = {
  nonce: string
  localSeq: number
  ordinal: number
  state: 'proposed' | 'engaged' | 'released'
  turnHeldBySender: boolean
  pauseEpoch: number
  senderReleased: boolean
}

export type EnqueueFederatedPactVerbOpts = {
  actorAgentId: string | null
  actorPaneKey: string | null
  actorHostId: string | null
  runId: string
  senderPaneKey?: string | null
  bodyText?: string
  subject?: string
  acknowledgeGate?: boolean
  infraAllowlist?: readonly string[]
  // Ledger (skipped for the no-ledger verbs, §2.5).
  ordinal?: number
  turnAfterAgentId?: string | null
  reasonCode?: string | null
  summary?: string | null
  // §2.4 wire payload fields.
  stepsTotal?: number | null
  wireOrdinal?: number
  rebind?: { oldAgentId: string }
  resyncRequest?: { nonce: string }
  resync?: FederatedPactResyncPayload
  // B15 (§2.7, ruling 21b-E7): pause/resume's `threads` mutation, run in THIS transaction so
  // the emit primitive stays the single atomic writer (mirrors `step`'s own precedent).
  threadStateMutation?: { pausedAt: 'now' | null; pauseReason: string | null }
  // B15 (§2.7 N10/T32): pause/resume coalesce CROSS-KIND — a queued pact_pause is replaced by
  // a later resume (and vice versa) rather than left as two items.
  coalesceAcrossRelayKinds?: readonly RelayKind[]
}

export type EnqueueFederatedPactVerbResult =
  | {
      outcome: 'enqueued'
      thread: ReturnType<typeof requireThread>
      seq: number
      era: number
      outboxId: string
      message: MessageRow
    }
  | {
      outcome: 'relay_pending'
      thread: ReturnType<typeof requireThread>
      seq: number
      era: number
      pendingToken: PactRelayPendingToken
      message: MessageRow
    }
  | { outcome: 'refused'; verdict: Extract<GateVerdict, { tier: 'hard' }>; refusalId: number }

// The `Within` form: steps 1-5 without opening its own transaction (precondition: the caller
// already holds `BEGIN IMMEDIATE` — see pact-federated-emit.ts for the wrapper that owns it).
export function enqueueFederatedPactVerbWithin(
  db: Database.Database,
  threadId: string,
  verb: FederatedPactVerb,
  opts: EnqueueFederatedPactVerbOpts
): EnqueueFederatedPactVerbResult {
  if (!db.inTransaction) {
    throw new Error(
      `internal error: enqueueFederatedPactVerbWithin called for ${threadId} outside an open transaction`
    )
  }
  const thread = requireThread(db, threadId)
  if (!isFederatedPact(thread)) {
    throw new Error(
      `internal error: enqueueFederatedPactVerb called for a local (non-federated) pact on ${threadId}`
    )
  }
  const linkDeviceId = thread.pact_peer_link_device_id
  const environmentId = thread.pact_peer_environment_id
  const peerAgentId = thread.pact_peer_agent_id
  if (linkDeviceId === null || environmentId === null || peerAgentId === null) {
    throw new Error(
      `internal error: federated pact thread ${threadId} is missing a peer anchor column`
    )
  }
  const binding = getPeerLinkBinding(db, linkDeviceId)
  if (!binding) {
    throw new Error(
      `internal error: federated pact thread ${threadId} names link ${linkDeviceId}, which has no peer_link_bindings row`
    )
  }

  // D-R135 F14: otherPactParticipant('') never matches either party, so it always fell through
  // to pact_proposer_agent_id — OUR OWN key on a pact this host proposed, for every host-emitted
  // verb (opts.actorAgentId null: gap_notice, resync_request, resync). A federated pact's two
  // named parties are always {a local agents.id, a rendered `remote:<link>:<id>` peer key} — the
  // peer is whichever one carries that prefix, independent of which side proposed.
  const counterpartKey = opts.actorAgentId
    ? otherPactParticipant(thread, opts.actorAgentId)
    : (thread.pact_proposer_agent_id ?? '').startsWith('remote:')
      ? (thread.pact_proposer_agent_id as string)
      : (thread.pact_with_agent_id as string)
  const noLedger = PACT_NO_LEDGER_VERBS.has(verb)
  const turnConsuming = PACT_TURN_CONSUMING_VERBS.has(verb)
  const reserved = PACT_RESERVED_VERBS.has(verb)
  const relayKind = PACT_VERB_RELAY_KIND[verb]

  // Step 1.
  const inserted = insertGatedMessage(db, {
    from: opts.actorAgentId ? pactWaiterHandle(opts.actorAgentId) : 'host',
    to: counterpartKey,
    subject: opts.subject ?? `pact ${verb}`,
    body: opts.bodyText ?? '',
    type: 'status',
    threadId: thread.id,
    hostPayloadKind: `pact_${verb}`,
    deliveryContract: verb === 'step' ? 'current_delivery' : 'audit_only',
    runId: opts.runId,
    senderPaneKey: opts.senderPaneKey ?? opts.actorPaneKey,
    senderHostId: opts.actorHostId ?? 'local',
    acknowledgeGate: opts.acknowledgeGate,
    infraAllowlist: opts.infraAllowlist,
    verb
  })
  if (inserted.outcome === 'refused') {
    return { outcome: 'refused', verdict: inserted.verdict, refusalId: inserted.refusalId }
  }
  const message = inserted.message
  bumpThreadOnMessage(db, thread.id, message)

  // B15 (§2.7, ruling 21b-E7): pause/resume's state mutation, in this same transaction.
  const psm = opts.threadStateMutation
  if (psm) {
    applyPactPauseResumeState(db, thread.id, psm.pausedAt, psm.pauseReason)
  }

  // S10-21b B6c: accept/release/decline's own host-local state transition, in this same
  // transaction — mirrors `step`'s own pact_ordinal special case below (step 2's `if (verb ===
  // 'step' ...)` block) rather than threading a fourth opts shape through every call site.
  // MUST run before step 5 (the outbox enqueue) reads `threads.pact_state`/`pact_flight_token`
  // fresh (reply-outbox-store.ts's enqueueReplyOutbox — never passed in by the caller) so the
  // relayed row snapshots the POST-transition state. `propose`'s own transition (era/seq reset
  // + peer-anchor population, B6b/B14) already committed in the CALLER's own transaction
  // before this one opened (proposePact) — it never re-enters here.
  if (verb === 'accept') {
    // `trg_pact_turn_membership` (db.ts, load-bearing, untouched) fires on ANY update that
    // leaves a row with pact_state='engaged' and demands pact_turn_agent_id be non-null and a
    // participant — unlike `step` (which never changes pact_state and so never trips it), an
    // engaged-but-turn-deferred accept is not a state the DB will accept. The turn write
    // itself is therefore immediate, same value the local path writes; `pact_turn_in_flight_at`
    // (turnConsuming, step 4 below) still tracks the unsettled relay, and settle's own
    // (idempotent, same value) turn write is what actually clears it.
    db.prepare(
      `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?,
         pact_flight_token = pact_flight_token + 1
       WHERE id = ?`
    ).run(opts.turnAfterAgentId ?? null, thread.id)
  } else if (verb === 'release' || verb === 'decline') {
    // N9 (batch-1 review, binding): this UPDATE is reached ONLY from the LOCAL release/decline
    // caller (releasePactRow) — never from inbound apply, a wholly separate code path — so
    // `pact_release_at` here is always the local host's own release, never a peer's.
    db.prepare(
      `UPDATE threads SET pact_state = 'released', pact_turn_agent_id = NULL,
         pact_paused_at = NULL, pact_pause_reason = NULL,
         pact_flight_token = pact_flight_token + 1,
         pact_release_at = CASE WHEN ? = 'release' THEN datetime('now') ELSE pact_release_at END
       WHERE id = ?`
    ).run(verb, thread.id)
  }

  // Step 2.
  if (!noLedger) {
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: opts.ordinal ?? 0,
      kind: verb as PactStepKind,
      actorAgentId: opts.actorAgentId,
      actorPaneKey: opts.actorPaneKey,
      actorHostId: opts.actorHostId,
      messageId: message.id,
      summary: opts.summary ?? null,
      turnAfterAgentId: opts.turnAfterAgentId ?? null,
      reasonCode: opts.reasonCode ?? null,
      relayState: 'pending'
    })
    // `step` advances this host's own local ledger progress (pact_ordinal) immediately at
    // emit — that is independent of the turn-holder column, which stays put until settle
    // (step 4 below). No other ledger verb in this commit's scope touches pact_ordinal.
    if (verb === 'step' && opts.ordinal !== undefined) {
      db.prepare(`UPDATE threads SET pact_ordinal = ? WHERE id = ?`).run(opts.ordinal, thread.id)
    }
  }

  // Step 3. S10-21b B17 (D-R138 B-F1, errata 21b-E7a, LR-018 — the prior cross-kind coalescing
  // ruling was WRONG): a coalesced REPLACEMENT must not consume a new wire seq — unconditional
  // bumping let a rapid pause→resume flip burn a seq nothing was ever sent for, desyncing the
  // peer's fence. Replace-vs-insert is decided HERE, before the bump, mirroring step 5's own
  // coalesce lookup (guaranteed to find the same row within one transaction); a replacement
  // reuses the current `pact_local_seq` untouched, only a fresh insert bumps.
  const coalesceExistingId = resolveCoalesceTarget(
    db,
    thread.id,
    verb,
    relayKind,
    opts.coalesceAcrossRelayKinds
  )
  if (coalesceExistingId === null) {
    db.prepare(`UPDATE threads SET pact_local_seq = pact_local_seq + 1 WHERE id = ?`).run(thread.id)
  }
  const seqRow = db
    .prepare(`SELECT pact_local_seq, pact_era FROM threads WHERE id = ?`)
    .get(thread.id) as { pact_local_seq: number; pact_era: number }
  const seq = seqRow.pact_local_seq
  const era = seqRow.pact_era

  // Step 4.
  if (turnConsuming) {
    db.prepare(`UPDATE threads SET pact_turn_in_flight_at = datetime('now') WHERE id = ?`).run(
      thread.id
    )
  }

  // 21b-D1: the envelope carries toAgentId/messageId/subject at top level (mail-literal
  // shape, orchestration-reply-foreign.ts:126-137) with `pact` attached — see
  // pact-federated-wire-envelope.ts for the full rationale (split out, max-lines ratchet).
  const payloadJson = buildPactWirePayload(db, {
    actorAgentId: opts.actorAgentId,
    verb,
    seq,
    era,
    peerAgentId,
    threadId: thread.id,
    subject: message.subject,
    messageId: message.id,
    stepsTotal: opts.stepsTotal,
    wireOrdinal: opts.wireOrdinal,
    reasonCode: opts.reasonCode,
    rebind: opts.rebind,
    resyncRequest: opts.resyncRequest,
    resync: opts.resync
  })

  // Step 5. B9c (D-R134 F7/D-R135 F6): `resync` (the ANSWER) occupies one slot per pact — an
  // existing unsettled row for it is REPLACED, never appended (enqueueReplyOutboxCoalesced).
  let outboxId: string | null = null
  let pendingToken: PactRelayPendingToken | null = null
  try {
    const outboxParams = {
      localMessageId: message.id,
      linkDeviceId,
      environmentId,
      boundPairingRevision: binding.boundPairingRevision,
      peerCredentialFp: binding.peerCredentialFp,
      peerKeyFingerprint: binding.peerKeyFingerprint,
      inReplyToMessageId: message.id,
      peerAgentId,
      peerThreadId: thread.pact_peer_thread_id,
      localThreadId: thread.id,
      noticeRunId: null,
      noticePaneKey: opts.actorPaneKey,
      payload: payloadJson,
      byteCount: Buffer.byteLength(payloadJson, 'utf8'),
      createdAt: Date.now(),
      reserved,
      pactThreadId: thread.id,
      pactSeq: seq,
      pactEra: era,
      pactTurnAfter: opts.turnAfterAgentId ?? undefined,
      relayKind
    }
    outboxId = opts.coalesceAcrossRelayKinds
      ? enqueueReplyOutboxCoalescedAcrossKinds(db, opts.coalesceAcrossRelayKinds, outboxParams)
      : enqueueReplyOutboxCoalesced(db, verb === 'resync', outboxParams)
  } catch (err) {
    if (err instanceof LinkBindingCapError) {
      const token = PACT_RELAY_PENDING_TOKEN[verb]
      if (token === undefined) {
        throw err
      }
      pendingToken = token
      db.prepare(`UPDATE threads SET pact_relay_pending = ? WHERE id = ?`).run(token, thread.id)
    } else {
      throw err
    }
  }

  const updated = requireThread(db, thread.id)

  if (pendingToken !== null) {
    return { outcome: 'relay_pending', thread: updated, seq, era, pendingToken, message }
  }
  // Step 6's kick half runs OUTSIDE the transaction — the `enqueueFederatedPactVerb` wrapper
  // does it, keyed off `updated.pact_peer_link_device_id`, never `Within` itself.
  return { outcome: 'enqueued', thread: updated, seq, era, outboxId: outboxId as string, message }
}
