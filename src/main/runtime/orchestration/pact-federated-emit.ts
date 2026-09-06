// S10-21b B6 (design §2.3, §2.4, §2.11, Ruling 34 Addendum 6(1)) — the shared federated-pact
// emit primitive: the deferred-turn-flip sequence (§2.3's six numbered steps), parameterised
// over the ten local verbs. Every future federated call site (this commit's own `step` wiring
// in pact-step.ts; commits 8/9/13's `rebind_party`/`resync`/`resync_request` emissions) calls
// THIS function rather than re-deriving the sequence — the single place the six steps are
// written down.
//
// Scope note (brief OPEN item, chair answer 3): this commit builds the primitive and wires it
// into `step` (the one verb this commit's own tests exercise end to end, T3). `propose`,
// `accept`, `decline`, `pause`, `resume`, `release` are NOT wired into their existing local-verb
// functions here — the design's own Gate-1 line for this commit names exactly one local-pact
// behaviour change (`autoPausePactOnThread`'s predicate), so no other existing call path may
// change behaviour in this commit. Wiring those verbs' federated arms into
// proposePact/acceptPact/pausePact/resumePact/releasePactRow is left to whichever commit turns
// on the federated CLI acceptance surface for them; the primitive here is ready for that commit
// to call without re-deriving §2.3.
import type Database from '../../sqlite/sync-database'
import type { GateVerdict } from '../../../shared/message-body-gate'
import type { MessageRow } from './types'
import type { PactStepKind } from './pact-types'
import { insertGatedMessage } from './message-gate-writer'
import { bumpThreadOnMessage } from './thread-directory'
import {
  insertPactStepRow,
  otherPactParticipant,
  pactWaiterHandle,
  requireThread
} from './pact-shared'
import { isFederatedPact } from './pact-federated-identity'
import type { RelayKind } from './reply-outbox-store'
import { enqueueReplyOutboxCoalesced } from './reply-outbox-pact-answer-coalesce'
import { getPeerLinkBinding, LinkBindingCapError } from './link-binding-store'
// 21b-D1: `fromAgent`'s shape mirrors buildFederatedSenderIdentity (federated-sender-identity.ts:56-70)
// exactly, but that helper takes `OrchestrationDb`, which this module never has (it only ever
// receives the raw `Database.Database` handle, matching pact-shared.ts's own `getAgentById`
// import below for the identical reason) — so the same underlying free function is used directly
// here instead of the wrapped helper. See buildFederatedSenderIdentityFromRawDb below.
import { getAgentById } from './agent-directory'
import type { FederatedSenderIdentity } from './federated-sender-identity'

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
const PACT_VERB_RELAY_KIND: Record<FederatedPactVerb, RelayKind> = {
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
export const PACT_RESERVED_VERBS: ReadonlySet<FederatedPactVerb> = new Set([
  'release',
  'rebind_party',
  'resync',
  'resync_request',
  'gap_notice'
])

// §2.2/§2.1: the in-flight guard applies to a verb that hands the turn to the peer. This
// commit's own test coverage (T3) exercises `step` only — the one turn-consuming verb this
// commit wires end to end; `accept`'s own turn-setting emit path is left for whichever commit
// wires accept's federated arm, to avoid asserting an in-flight behaviour this commit does not
// test.
export const PACT_TURN_CONSUMING_VERBS: ReadonlySet<FederatedPactVerb> = new Set(['step'])

// §2.11: `threads.pact_relay_pending` — DEVIATION (B9c, D-R134 F7/D-R135 F6): the design's
// closed four-value vocabulary ('release'|'rebind'|'resync_request'|'gap_notice') has no slot
// for the resync ANSWER, whose own `LinkBindingCapError` used to propagate AFTER
// recordPactAppliedId already committed — the peer's retry then deduped and the answer was lost
// for good. A fifth token, 'resync', closes that hole the same way the other three do; nothing
// drains it yet (matching 'release'/'resync_request', neither of which has a drainer landed
// either — future work, not this commit's scope).
export type PactRelayPendingToken = 'release' | 'rebind' | 'resync_request' | 'resync'
const PACT_RELAY_PENDING_TOKEN: Partial<Record<FederatedPactVerb, PactRelayPendingToken>> = {
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

export type FederatedPactEmitRuntime = { replyOutbox?: { kick(linkDeviceId: string): void } | null }

// 21b-D1: same construction as buildFederatedSenderIdentity (federated-sender-identity.ts:56-70),
// against the raw `Database.Database` handle this module has rather than `OrchestrationDb`.
// Returns undefined when the actor has no registered `agents` row — the caller then omits
// `fromAgent` from the envelope entirely, exactly as the mail path does.
function buildFederatedSenderIdentityFromRawDb(
  db: Database.Database,
  actorAgentId: string
): FederatedSenderIdentity | undefined {
  const row = getAgentById(db, actorAgentId)
  if (!row) {
    return undefined
  }
  return {
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    quarantined: row.quarantined === 1
  }
}

// The shared emit primitive (design §2.3's six steps, one `BEGIN IMMEDIATE`):
//   1. insertGatedMessage (single write choke)
//   2. insertPactStepRow with relay_state='pending' (skipped for the no-ledger verbs)
//   3. pact_local_seq += 1
//   4. pact_turn_in_flight_at set for a turn-consuming verb (turn itself never moves here —
//      settle-time only, commit 7)
//   5. enqueueReplyOutbox in try/catch, LinkBindingCapError falling back to pact_relay_pending
//      for the three verbs that have a token (release/rebind_party/resync_request)
//   6. commit, then runtime.replyOutbox?.kick(linkDeviceId) OUTSIDE the transaction
export function enqueueFederatedPactVerb(
  db: Database.Database,
  runtime: FederatedPactEmitRuntime | null,
  threadId: string,
  verb: FederatedPactVerb,
  opts: EnqueueFederatedPactVerbOpts
): EnqueueFederatedPactVerbResult {
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

  const counterpartKey = otherPactParticipant(thread, opts.actorAgentId ?? '')
  const noLedger = PACT_NO_LEDGER_VERBS.has(verb)
  const turnConsuming = PACT_TURN_CONSUMING_VERBS.has(verb)
  const reserved = PACT_RESERVED_VERBS.has(verb)
  const relayKind = PACT_VERB_RELAY_KIND[verb]

  db.exec('BEGIN IMMEDIATE')
  try {
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
      db.exec('COMMIT')
      return { outcome: 'refused', verdict: inserted.verdict, refusalId: inserted.refusalId }
    }
    const message = inserted.message
    bumpThreadOnMessage(db, thread.id, message)

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

    // Step 3.
    db.prepare(`UPDATE threads SET pact_local_seq = pact_local_seq + 1 WHERE id = ?`).run(thread.id)
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

    const wirePact: Record<string, unknown> = { verb, seq, era }
    if (opts.stepsTotal !== undefined) {
      wirePact.stepsTotal = opts.stepsTotal
    }
    if (opts.wireOrdinal !== undefined) {
      wirePact.ordinal = opts.wireOrdinal
    }
    if (opts.reasonCode !== undefined) {
      wirePact.reasonCode = opts.reasonCode
    }
    if (opts.rebind !== undefined) {
      wirePact.rebind = opts.rebind
    }
    if (opts.resyncRequest !== undefined) {
      wirePact.resyncRequest = opts.resyncRequest
    }
    if (opts.resync !== undefined) {
      wirePact.resync = opts.resync
    }

    // 21b-D1 (F1-F4, README "after the 21b-D1 fact sweep"): the pump's dial sends `params:
    // JSON.parse(item.payload)` verbatim (reply-outbox-pump.ts:135-147) against
    // FederatedSendParams (orchestration-federated-peer-send.ts:41-56), which requires
    // toAgentId/messageId/subject at top level — `{ pact: wirePact }` alone always failed that
    // parse. The envelope below carries the mail literal's shape (orchestration-reply-
    // foreign.ts:126-137) with `pact` attached; `wirePact` itself is byte-identical to before
    // this commit.
    //   fromAgent — buildFederatedSenderIdentityFromRawDb (above), for the pact's LOCAL actor
    //     (opts.actorAgentId); omitted when the actor is unregistered/host, exactly as the mail
    //     path omits it for an unregistered pane.
    //   toAgentId — thread.pact_peer_agent_id (already read above as `peerAgentId`).
    //   messageId — message.id, the id `insertGatedMessage` (step 1, above) already minted for
    //     this row's own relay message via the same `msg_` + 12-hex generator the mail path's
    //     inline mint (orchestration-reply-foreign.ts:117) uses — already stamped as
    //     `localMessageId` in the enqueueReplyOutbox call below, so settleFederatedPactDelivery's
    //     correlation (pact-federated-settle.ts) is unchanged.
    //   threadId — thread.id (this host's OWN local thread id), REQUIRED on every pact verb
    //     including `propose` (deviation from the brief's "threads.pact_peer_thread_id when
    //     known, omit when null — first propose": gate 7, pact-federated-inbound-gates.ts:178-181,
    //     refuses a null/missing threadId unconditionally for a pact envelope — the comment there
    //     reads "Always present for a pact envelope (required here, optional at the general mail
    //     site)". Gate 9's thread lookup (pact-federated-inbound-gates.ts:241-243) matches the
    //     wire threadId against the RECEIVER's own `pact_peer_thread_id` column, which by
    //     construction holds THIS side's thread id (T1's own fixture in orchestration-federated-
    //     peer-send-pact-inbound.test.ts:118-131 seeds the receiver's `pact_peer_thread_id` to
    //     the literal value the wire `threadId` carries) — so `thread.pact_peer_thread_id` is the
    //     wrong field to send (it is null before any peer response, which would make every
    //     federated propose refuse invalid_argument, a regression); `thread.id` is what gate 9
    //     actually expects. The chair's own OPEN line on this brief anticipated "the threadId
    //     rule" might need review amendment — flagging this as the amendment.
    //   subject — message.subject (the same `opts.subject ?? \`pact ${verb}\`` default already
    //     passed to insertGatedMessage above; chair default per the brief, batch-2 reviewer
    //     invited to argue it).
    //   type/priority — 'status' / 'normal', matching the mail literal. body omitted (brief).
    //   pact — wirePact, unchanged.
    const fromAgent = opts.actorAgentId
      ? buildFederatedSenderIdentityFromRawDb(db, opts.actorAgentId)
      : undefined
    const envelope: Record<string, unknown> = {
      ...(fromAgent ? { fromAgent } : {}),
      toAgentId: peerAgentId,
      messageId: message.id,
      threadId: thread.id,
      subject: message.subject,
      type: 'status',
      priority: 'normal',
      pact: wirePact
    }
    const payloadJson = JSON.stringify(envelope)

    // Step 5. B9c (D-R134 F7/D-R135 F6): `resync` (the ANSWER) occupies one slot per pact — an
    // existing unsettled row for it is REPLACED, never appended (enqueueReplyOutboxCoalesced).
    let outboxId: string | null = null
    let pendingToken: PactRelayPendingToken | null = null
    try {
      outboxId = enqueueReplyOutboxCoalesced(db, verb === 'resync', {
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
      })
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

    // Step 6 (commit half).
    db.exec('COMMIT')
    const updated = requireThread(db, thread.id)

    if (pendingToken !== null) {
      return { outcome: 'relay_pending', thread: updated, seq, era, pendingToken, message }
    }
    // Step 6 (kick half) — outside the transaction.
    runtime?.replyOutbox?.kick(linkDeviceId)
    return { outcome: 'enqueued', thread: updated, seq, era, outboxId: outboxId as string, message }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
