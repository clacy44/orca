// S10-2a SINGLE WRITE CHOKE (ruling 2, GATE §). Every peer-facing send/ask/reply and the
// federation relay encode path route through `insertGatedMessage` — never `db.insertMessage`
// directly, which after this series is a host-lifecycle-only path (see the exemption list on
// `db.ts`'s `insertMessage`). Kept out of db.ts per that file's ratchet rule.
//
// A5 (s10-3-pact-spec rev 7): the pact-step discriminator is a dedicated additive
// `messages.payload_kind` column (see db.ts's v33->v34 migration), not a `payload.kind` JSON
// field — the JSON `payload.kind` namespace is already used by runtime notifications
// (input_not_consumed / liveness_breach / relay_unreachable). Enforced right here, the single
// write choke: `hostPayloadKind` writes the column; a caller-supplied `payload.kind` in the
// JSON is always refused (`payload_kind_reserved`), unconditionally — unlike an ordinary HARD
// gate verdict, this refusal is never softened by `acknowledgeGate` (GATE §'s escape hatch is
// for content-gate hits, not for a namespace callers must never be able to touch).
import { createHash, randomBytes } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { evaluateMessageBodyGate, type GateVerdict } from '../../../shared/message-body-gate'
import {
  extractPayloadGateText,
  sanitizeMessagePayloadFields,
  sanitizeMessageText,
  sanitizeMessageTextForGate
} from '../../../shared/message-text'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../shared/orchestration-rpc-contract'
import { getAgentByPaneKey } from './derived-agent-rows'
import type { MessageDeliveryContract, MessagePriority, MessageRow, MessageType } from './types'

function generateMessageId(): string {
  return `msg_${randomBytes(6).toString('hex')}`
}

/**
 * `payload` here is a JSON-serializable VALUE, sanitized field-wise then re-serialized — never
 * a pre-stringified string, which would be sanitized as one opaque text leaf and then
 * JSON.stringify'd AGAIN, double-encoding it (a `{"a":1}` object payload would come back as the
 * literal string `"{\"a\":1}"`, breaking every downstream `JSON.parse(message.payload)` reader).
 * Every RPC/legacy-compat call site that still carries `payload` as a wire string uses this to
 * bridge: parses when possible, and falls back to the raw string (one sanitized text leaf) when
 * it is not JSON — preserving a non-JSON payload's storability.
 */
export function payloadValueForGate(payload: string | null | undefined): unknown {
  if (payload === undefined || payload === null) {
    return undefined
  }
  try {
    return JSON.parse(payload)
  } catch {
    return payload
  }
}

const MESSAGE_SUBJECT_MAX_LENGTH = 200
const MESSAGE_BODY_MAX_LENGTH = 8000
const MESSAGE_PAYLOAD_FIELD_MAX_LENGTH = 2000

export type InsertGatedMessageParams = {
  id?: string
  from: string
  to: string
  subject: string
  body?: string
  type?: MessageType
  priority?: MessagePriority
  threadId?: string | null
  /** A JSON-serializable payload object. Sanitized field-wise (never as one flattened blob —
   * that would corrupt the JSON structure) and gated leaf-by-leaf. */
  payload?: unknown
  runId?: string
  deliveryContract?: MessageDeliveryContract
  /** Resolved via idx_agents_pane_suffix (ruling 7) — the ONLY writer of sender_agent_id. */
  senderPaneKey?: string | null
  senderHostId?: string
  recipientPaneKey?: string | null
  /** Writes the dedicated `messages.payload_kind` column (A5, pact-spec rev 7) — the pact-step
   * discriminator. Never derived from `payload`; a caller-supplied `payload.kind` in the JSON
   * is refused (`payload_kind_reserved`), never merged into this column. Host-only. */
  hostPayloadKind?: string | null
  /** Converts a HARD verdict into a stored-and-flagged send (gate_refusals.acknowledged = 1);
   * the channel is never closed outright (GATE § escape hatch). */
  acknowledgeGate?: boolean
  /** Newline-delimited infra literals, loaded and cached once per process by the caller. */
  infraAllowlist?: readonly string[]
  /** Audit verb recorded on a refusal — 'send' | 'ask' | 'reply' | 'purge_reason' | etc. */
  verb?: string
  // S10-15 (chair ruling 7) cross-host provenance — see db.ts's v38 messages column comment.
  /** Set ONLY on an inbound-imported row — the "authored remotely" discriminator. */
  peerLinkDeviceId?: string | null
  peerAgentId?: string | null
  peerThreadId?: string | null
  peerRelayedAt?: string | null
}

export type InsertGatedMessageResult =
  | { outcome: 'stored'; message: MessageRow; verdict: GateVerdict }
  | { outcome: 'refused'; verdict: Extract<GateVerdict, { tier: 'hard' }>; refusalId: number }

// A5 (rev 7): `payload.kind` is a reserved JSON key — the pact-step discriminator lives in the
// dedicated `payload_kind` column instead, so a caller setting `payload.kind` can never shadow
// or spoof it. Only a top-level `kind` own-property on a plain payload object is reserved;
// non-object payloads have no JSON namespace to collide with.
function payloadHasReservedKindField(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Object.hasOwn(payload, 'kind')
  )
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

// Amendment E fix (adversarial review major #3): a quarantined sender's id IS still stamped
// here — nulling it (the S10-2b original) actively defeated containment rather than protecting
// it. `message-visibility-filter.ts`'s live-read predicate (liveMessageSqlClause /
// filterLiveMessageRows) withholds a row from every other reader by re-checking
// `agents.quarantined` against `sender_agent_id` AT READ TIME — retroactively AND
// prospectively, on every send made after the quarantine too. That withholding needs the real
// id in the column; NULL trivially passes its `sender_agent_id IS NULL OR ... NOT IN (...)`
// clause, so a nulled row was never withheld, only unattributed — the opposite of containment.
// CONTAINMENT #7 (a quarantined row's name/role must never reach another pane) does not need
// this column nulled either: orca-runtime.ts's `resolveSenderAgent` callback into
// `formatMessagePointer` already re-checks `agent.quarantined === 1` at render time and falls
// back to the raw handle — independent of whether sender_agent_id is stamped. Centralized here
// (not at each RPC call site) so every insertGatedMessage caller — send, broadcast, reply, peer
// question, federation import — gets the real id automatically.
function resolveSenderAgentId(
  db: Database.Database,
  senderPaneKey: string | null | undefined,
  senderHostId: string
): string | null {
  if (!senderPaneKey) {
    return null
  }
  const agent = getAgentByPaneKey(db, senderHostId, senderPaneKey)
  return agent ? agent.id : null
}

function writeGateRefusal(
  db: Database.Database,
  params: {
    actorAgentId: string | null
    actorPaneKey: string | null
    actorHostId: string | null
    verb: string
    ruleIds: readonly string[]
    acknowledged: boolean
    subject: string
    body: string
  }
): number {
  // Why re-SELECT rather than trust .run()'s lastInsertRowid: matches writeAgentAudit's
  // precedent (agent-directory.ts) — one less cross-driver return-shape assumption to carry.
  db.prepare(
    `INSERT INTO gate_refusals
       (actor_agent_id, actor_pane_key, actor_host_id, verb, rule_ids, acknowledged,
        body_sha256, body_bytes, subject_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.actorAgentId,
    params.actorPaneKey,
    params.actorHostId,
    params.verb,
    JSON.stringify(params.ruleIds),
    params.acknowledged ? 1 : 0,
    sha256Hex(params.body),
    Buffer.byteLength(params.body, 'utf8'),
    sha256Hex(params.subject)
  )
  const row = db.prepare('SELECT seq FROM gate_refusals ORDER BY seq DESC LIMIT 1').get() as {
    seq: number
  }
  return row.seq
}

/**
 * The single write choke (ruling 2). Gates `sanitizeMessageTextForGate`'s output (GATE §, amended
 * per s10-2-spec.md:150) — NOT the raw subject/body/payload and NOT the fully-sanitized
 * (newline-collapsed) text that gets stored. Raw text under-gates: a zero-width codepoint or a
 * fullwidth-Unicode variant splits a HARD heading so it never matches, and `sanitizeMessageText`
 * (below, for storage) then normalizes it right back into a real heading in the stored/rendered
 * row — an invisible character would bypass containment and the sanitizer would clean the
 * evidence out of the row on the way in. Fully-sanitized text under-gates the other way: newline
 * collapse destroys h1's line-start anchor for a heading that is not the literal first line.
 * `sanitizeMessageTextForGate` applies the same normalization as storage while keeping line
 * breaks, so the gate sees what the reader will actually see either way. Resolves
 * `sender_agent_id` from the attested pane (ruling 7, write-side half of ruling 4) after the
 * verdict, and either stores the sanitized row (clean or soft-flagged) or writes a
 * `gate_refusals` audit row and stores nothing (hard, unless `acknowledgeGate`). Never throws on
 * a HARD verdict — refusal is a normal return value the RPC layer turns into an error.
 */
export function insertGatedMessage(
  db: Database.Database,
  params: InsertGatedMessageParams
): InsertGatedMessageResult {
  const senderHostId = params.senderHostId ?? 'local'
  const senderAgentId = resolveSenderAgentId(db, params.senderPaneKey, senderHostId)

  const rawBody = params.body ?? ''
  const rawPayloadGateText =
    params.payload === undefined ? undefined : extractPayloadGateText(params.payload)

  // Gate the normalized-but-line-preserving text (message-text.ts), not the raw bytes and not
  // the fully-sanitized (newline-collapsed) text — see sanitizeMessageTextForGate's doc comment.
  const verdict = evaluateMessageBodyGate({
    subject: sanitizeMessageTextForGate(params.subject),
    body: sanitizeMessageTextForGate(rawBody),
    payload:
      rawPayloadGateText === undefined ? undefined : sanitizeMessageTextForGate(rawPayloadGateText),
    infraAllowlist: params.infraAllowlist
  })

  const sanitizedSubject = sanitizeMessageText(params.subject, MESSAGE_SUBJECT_MAX_LENGTH).value
  const sanitizedBody = sanitizeMessageText(rawBody, MESSAGE_BODY_MAX_LENGTH).value
  const sanitizedPayload =
    params.payload === undefined
      ? undefined
      : sanitizeMessagePayloadFields(params.payload, MESSAGE_PAYLOAD_FIELD_MAX_LENGTH)
  const payloadJson = sanitizedPayload === undefined ? null : JSON.stringify(sanitizedPayload)

  const verb = params.verb ?? 'send'

  // A5 (rev 7): reserved-namespace refusal, unconditional — never softened by acknowledgeGate.
  if (payloadHasReservedKindField(params.payload)) {
    const refusalId = writeGateRefusal(db, {
      actorAgentId: senderAgentId,
      actorPaneKey: params.senderPaneKey ?? null,
      actorHostId: senderAgentId ? senderHostId : null,
      verb,
      ruleIds: ['payload_kind_reserved'],
      acknowledged: false,
      subject: sanitizedSubject,
      body: sanitizedBody
    })
    return {
      outcome: 'refused',
      verdict: { tier: 'hard', ruleIds: ['payload_kind_reserved'] },
      refusalId
    }
  }

  if (verdict.tier === 'hard' && !params.acknowledgeGate) {
    const refusalId = writeGateRefusal(db, {
      actorAgentId: senderAgentId,
      actorPaneKey: params.senderPaneKey ?? null,
      actorHostId: senderAgentId ? senderHostId : null,
      verb,
      ruleIds: verdict.ruleIds,
      acknowledged: false,
      subject: sanitizedSubject,
      body: sanitizedBody
    })
    return { outcome: 'refused', verdict, refusalId }
  }

  let gateFlags: string | null = null
  if (verdict.tier === 'soft') {
    gateFlags = JSON.stringify(verdict.ruleIds)
  } else if (verdict.tier === 'hard') {
    // acknowledgeGate: store flagged and audited rather than closing the channel.
    gateFlags = JSON.stringify(verdict.ruleIds)
    writeGateRefusal(db, {
      actorAgentId: senderAgentId,
      actorPaneKey: params.senderPaneKey ?? null,
      actorHostId: senderAgentId ? senderHostId : null,
      verb,
      ruleIds: verdict.ruleIds,
      acknowledged: true,
      subject: sanitizedSubject,
      body: sanitizedBody
    })
  }

  const id = params.id ?? generateMessageId()
  db.prepare(
    `INSERT INTO messages (
       id, run_id, delivery_contract, from_handle, to_handle, subject, body,
       type, priority, thread_id, payload, sender_pane_key, recipient_pane_key,
       sender_agent_id, gate_flags, payload_kind,
       peer_link_device_id, peer_agent_id, peer_thread_id, peer_relayed_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.runId ?? ORCHESTRATION_LEGACY_RUN_ID,
    params.deliveryContract ?? 'current_delivery',
    params.from,
    params.to,
    sanitizedSubject,
    sanitizedBody,
    params.type ?? 'status',
    params.priority ?? 'normal',
    params.threadId ?? null,
    payloadJson,
    params.senderPaneKey ?? null,
    params.recipientPaneKey ?? null,
    senderAgentId,
    gateFlags,
    params.hostPayloadKind ?? null,
    params.peerLinkDeviceId ?? null,
    params.peerAgentId ?? null,
    params.peerThreadId ?? null,
    params.peerRelayedAt ?? null
  )

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow
  return { outcome: 'stored', message, verdict }
}
