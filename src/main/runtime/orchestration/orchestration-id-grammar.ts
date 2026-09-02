// S10-20 (Ruling 22 scope 1+2; INV-P-012 clause 5): ONE grammar for the ids a peer may hand this
// host. Mirrors the mint sites verbatim — message-gate-writer.ts:27-29 (`msg_` + 12 hex),
// thread-directory.ts:16-18 (`thr_` + 12 hex), and db.ts:6705 `generateId('relay')` (`relay_` +
// 12 hex, the relay ENVELOPE id every federation-relay item carries as `message_id` on the wire —
// confirmed the ONLY minter of `relay_` ids in src/, and confirmed unreachable by any
// peer-supplied value: every one of `enqueueFederationRelay`'s 7 production call sites
// (orchestration.ts:719/840/1814/1911/2955, orchestration-federation-setup.ts:79,
// dispatch-input-observer.ts:214) omits `messageId`, so the field always falls back to the
// host's own mint) — and generalizes the already-shipped RELAYED_MESSAGE_ID_RE
// (orchestration-federated-peer-send.ts:24) so every wire ingress refuses the same shapes,
// instead of one ingress being tight and five being open.
//
// MESSAGE_ID role accepts BOTH `msg_`+12hex (message-gate-writer's own row id) and
// `relay_`+12hex (the relay envelope id) because `item.message_id` on the wire is, in
// production, almost always the relay envelope id, not a `messages` row id — the two are
// different lengths (16 vs 18 chars) but the same construction (`generateId(prefix)` =
// `${prefix}_${randomBytes(6).toString('hex')}`), so length is not part of the shape check here;
// the anchored regex alone is the bound.
//
// THREAD_ID role additionally accepts `relay_`+12hex (chair ruling, S10-20 escalation finding 2)
// for the identical reason: `orchestration.ts:1924`'s generic-reply-to-escalation relay sends
// `threadId: original.thread_id ?? original.id`, where `original` is a message imported via the
// pull path (I-5/I-6) whose `id` is the relay envelope id (`item.message_id`) — so `original.id`
// in the threadId fallback slot is routinely `relay_`-shaped, not `msg_`-shaped. Same host-minted
// construction as the MESSAGE_ID case, same unreachable-by-peer-input guarantee (fact (b) above).
import { OrchestrationError } from './orchestration-error'

// S10-20 review F11: a distinct subclass so the audit gate can key on identity (unforgeable —
// `throwOrchestrationWorkerServerError` at orca-runtime.ts:5103 constructs a plain
// `OrchestrationError`, never this subclass) instead of on `data.reasonCode`, which a peer's own
// failure envelope can carry verbatim across the wire (runtime-rpc-envelope.ts:35-41's `data` is
// `z.unknown()`). `data.reasonCode` is kept for CLI display/logging only — it must never be the
// thing a gate decides on.
export class HostIdGrammarError extends OrchestrationError {}

export const HOST_MESSAGE_ID_RE = /^(?:msg|relay)_[0-9a-f]{12}$/
export const HOST_THREAD_ID_RE = /^(?:thr|msg|relay)_[0-9a-f]{12}$/

// S10-20 review F3: the longer of the two constructions this grammar accepts (`relay_` + 12 hex
// = 18 chars) — the single render-clamp bound so a legitimate id is never truncated in a pointer.
export const HOST_ID_MAX_LENGTH = 18

export function isHostMessageId(value: unknown): value is string {
  return typeof value === 'string' && HOST_MESSAGE_ID_RE.test(value)
}

// Why `msg_`/`relay_` are accepted for a THREAD id and not a bug: the host's own outbound
// encoders send a message/relay id in the threadId slot as a fallback — `original.thread_id ??
// original.id` at orchestration.ts:1924 (federated relay) and :1973 (local-only reply, unaffected
// since it never crosses the wire) — and the render side reads the same fallback
// (formatter.ts:224). A thr_-only rule would refuse every legitimate coordinator reply.
export function isHostThreadId(value: unknown): value is string {
  return typeof value === 'string' && HOST_THREAD_ID_RE.test(value)
}

/** Typed, effect-free refusal. Callers write the audit row (they own the actor identity). */
export function requireHostMessageId(value: unknown, field: string): string {
  if (!isHostMessageId(value)) {
    throw new HostIdGrammarError(
      'invalid_argument',
      `The relayed ${field} is not a valid message id.`,
      {
        // S10-20 review F4/F5: marks the refusal as an id-grammar refusal at the throw site, so
        // callers can write an id-refusal audit row only when THIS marker is present, never by
        // sniffing the error code (which a peer's own invalid_argument rethrow would also match).
        reasonCode: 'malformed_relay_id',
        nextSteps: [
          'this indicates a version-mismatched or malformed peer relay — update Orca on the sending host'
        ]
      }
    )
  }
  return value
}

export function requireHostThreadId(value: unknown, field: string): string {
  if (!isHostThreadId(value)) {
    throw new HostIdGrammarError(
      'invalid_argument',
      `The relayed ${field} is not a valid thread id.`,
      {
        reasonCode: 'malformed_relay_id',
        nextSteps: [
          'this indicates a version-mismatched or malformed peer relay — update Orca on the sending host'
        ]
      }
    )
  }
  return value
}

/** Optional thread id: absent stays absent; PRESENT-AND-MALFORMED REFUSES (never silently null). */
export function requireOptionalThreadId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null
  }
  return requireHostThreadId(value, field)
}
