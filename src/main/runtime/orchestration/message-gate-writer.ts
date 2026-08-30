// S10-2a SINGLE WRITE CHOKE (ruling 2, GATE §). Every peer-facing send/ask/reply and the
// federation relay encode path route through `insertGatedMessage` — never `db.insertMessage`
// directly, which after this series is a host-lifecycle-only path (see the exemption list on
// `db.ts`'s `insertMessage`). Kept out of db.ts per that file's ratchet rule.
//
// A5 (s10-3-pact-spec rev 6): `payload.kind` is host-written. A caller-supplied `kind` inside
// `payload` is always refused (`payload_kind_reserved`), even with `acknowledgeGate` — this is
// a structural rule, not a content-gate verdict, so the escape hatch does not apply to it. The
// only legal way to set one is `hostPayloadKind`, a typed entry point reachable only from
// trusted in-process callers (S10-3's `appendPactStep`, which will pass `'pact_step'`) — never
// from a caller-controlled RPC parameter.
import { createHash, randomBytes } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { evaluateMessageBodyGate, type GateVerdict } from '../../../shared/message-body-gate'
import {
  extractPayloadGateText,
  sanitizeMessagePayloadFields,
  sanitizeMessageText
} from '../../../shared/message-text'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../shared/orchestration-rpc-contract'
import { getAgentByPaneKey } from './derived-agent-rows'
import type { MessageDeliveryContract, MessagePriority, MessageRow, MessageType } from './types'

function generateMessageId(): string {
  return `msg_${randomBytes(6).toString('hex')}`
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
  /** Converts a HARD verdict into a stored-and-flagged send (gate_refusals.acknowledged = 1);
   * the channel is never closed outright (GATE § escape hatch). */
  acknowledgeGate?: boolean
  /** Newline-delimited infra literals, loaded and cached once per process by the caller. */
  infraAllowlist?: readonly string[]
  /** Audit verb recorded on a refusal — 'send' | 'ask' | 'reply' | 'purge_reason' | etc. */
  verb?: string
  /**
   * A5, host-internal only. The sole intended caller is S10-3's `appendPactStep`. Never wire
   * this to a caller-controlled RPC parameter — a caller sets a step by calling
   * `orca agents step`, never by putting `kind` directly in a message payload.
   */
  hostPayloadKind?: string
}

export const PAYLOAD_KIND_RESERVED_MESSAGE =
  'Refused: payload.kind is set by the host — a step is recorded with orca agents step, not by sending a message.'

export type InsertGatedMessageResult =
  | { outcome: 'stored'; message: MessageRow; verdict: GateVerdict }
  | { outcome: 'refused'; verdict: Extract<GateVerdict, { tier: 'hard' }>; refusalId: number }
  | { outcome: 'payload_kind_reserved' }

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function resolveSenderAgentId(
  db: Database.Database,
  senderPaneKey: string | null | undefined,
  senderHostId: string
): string | null {
  if (!senderPaneKey) {
    return null
  }
  return getAgentByPaneKey(db, senderHostId, senderPaneKey)?.id ?? null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// A5: refuses a caller-supplied payload.kind outright; only a trusted in-process caller
// (hostPayloadKind) may stamp one in.
function resolveGatedPayload(
  params: Pick<InsertGatedMessageParams, 'payload' | 'hostPayloadKind'>
): { ok: true; payload: unknown } | { ok: false } {
  if (params.payload !== undefined && isPlainObject(params.payload) && 'kind' in params.payload) {
    return { ok: false }
  }
  if (params.hostPayloadKind === undefined) {
    return { ok: true, payload: params.payload }
  }
  if (params.payload !== undefined && !isPlainObject(params.payload)) {
    return { ok: false }
  }
  return {
    ok: true,
    payload: {
      ...(params.payload as Record<string, unknown> | undefined),
      kind: params.hostPayloadKind
    }
  }
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
 * The single write choke (ruling 2). Sanitizes subject/body/payload (write-side half of ruling
 * 4), resolves `sender_agent_id` from the attested pane (ruling 7), runs the post-time gate
 * (GATE §) over the sanitized text, and either stores the row (clean or soft-flagged) or writes
 * a `gate_refusals` audit row and stores nothing (hard, unless `acknowledgeGate`). Never throws
 * on a HARD verdict — refusal is a normal return value the RPC layer turns into an error.
 */
export function insertGatedMessage(
  db: Database.Database,
  params: InsertGatedMessageParams
): InsertGatedMessageResult {
  const gatedPayload = resolveGatedPayload(params)
  if (!gatedPayload.ok) {
    return { outcome: 'payload_kind_reserved' }
  }

  const senderHostId = params.senderHostId ?? 'local'
  const senderAgentId = resolveSenderAgentId(db, params.senderPaneKey, senderHostId)

  const sanitizedSubject = sanitizeMessageText(params.subject, MESSAGE_SUBJECT_MAX_LENGTH).value
  const sanitizedBody = sanitizeMessageText(params.body ?? '', MESSAGE_BODY_MAX_LENGTH).value
  const sanitizedPayload =
    gatedPayload.payload === undefined
      ? undefined
      : sanitizeMessagePayloadFields(gatedPayload.payload, MESSAGE_PAYLOAD_FIELD_MAX_LENGTH)
  const payloadGateText =
    sanitizedPayload === undefined ? undefined : extractPayloadGateText(sanitizedPayload)
  const payloadJson = sanitizedPayload === undefined ? null : JSON.stringify(sanitizedPayload)

  const verdict = evaluateMessageBodyGate({
    subject: sanitizedSubject,
    body: sanitizedBody,
    payload: payloadGateText,
    infraAllowlist: params.infraAllowlist
  })

  const verb = params.verb ?? 'send'

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
       sender_agent_id, gate_flags
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    gateFlags
  )

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow
  return { outcome: 'stored', message, verdict }
}
