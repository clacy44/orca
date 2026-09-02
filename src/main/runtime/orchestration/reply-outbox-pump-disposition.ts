// S10-16 C5, R18.5/R18.8: the pure classification half of the pump's catch block — split out of
// reply-outbox-pump.ts to stay under the max-lines ratchet. Reads exactly the closed-enumeration
// fields R18.8 names (error.code, error.data.retryAfterMs) and returns a disposition; the pump
// applies it (the DB writes, the notice) — no I/O happens in this file.
import { OrchestrationError } from './orchestration-error'
import { replyOutboxIntervalMs } from './reply-outbox-store'
import { classifyPeerRefusalCode, type ReplyRelayNoticeCode } from './reply-outbox-health'
import {
  LINK_BINDING_RETRY_MIN_MS,
  LINK_BINDING_RETRY_MAX_MS,
  REPLY_RELAY_PEER_RECEIPT_POISONED_NOTICE,
  REPLY_RELAY_ID_CONFLICT_NOTICE,
  REPLY_RELAY_REFUSED_NOTICE
} from './link-binding-constants'

export type ReplyRelayErrorDisposition =
  | { kind: 'refused'; code: string; noticeCode: ReplyRelayNoticeCode; errorMessage: string }
  | { kind: 'retry'; disposition: string; nextAttemptAfter: number; errorMessage: string }

function clampRetryAfterMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    return null
  }
  return Math.min(Math.max(v, LINK_BINDING_RETRY_MIN_MS), LINK_BINDING_RETRY_MAX_MS)
}

const KNOWN_REFUSAL_CODES = new Set([
  'agent_quarantined',
  'agent_unknown',
  'agent_retired',
  'derived_agent_unaddressable',
  'operation_unknown',
  'request_mismatch',
  'not_the_addressee',
  'body_gate_refused',
  'sensitive_thread_no_federation',
  'invalid_argument'
])

// R18.5's disposition table + R18.8's closed error read, as one pure function.
export function classifyReplyRelayError(
  error: unknown,
  attemptsAfterClaim: number,
  now: number
): ReplyRelayErrorDisposition {
  const errorCode = (error as { code?: unknown } | null)?.code
  const code =
    error instanceof OrchestrationError
      ? error.code
      : typeof errorCode === 'string'
        ? errorCode
        : 'unknown_peer_refusal'
  const errorMessage = error instanceof Error ? error.message : String(error)

  if (KNOWN_REFUSAL_CODES.has(code)) {
    const noticeCode: ReplyRelayNoticeCode =
      code === 'operation_unknown'
        ? REPLY_RELAY_PEER_RECEIPT_POISONED_NOTICE
        : code === 'request_mismatch'
          ? REPLY_RELAY_ID_CONFLICT_NOTICE
          : REPLY_RELAY_REFUSED_NOTICE
    return { kind: 'refused', code, noticeCode, errorMessage }
  }

  // Transport-shaped (or unknown/untyped): retry, with a bounded, jittered backoff.
  let nextAttemptAfter = now + replyOutboxIntervalMs(attemptsAfterClaim)
  if (code === 'rate_limited') {
    const retryAfterMs = clampRetryAfterMs(
      (error as OrchestrationError | undefined)?.data &&
        typeof (error as OrchestrationError).data === 'object'
        ? ((error as OrchestrationError).data as { retryAfterMs?: unknown }).retryAfterMs
        : undefined
    )
    nextAttemptAfter = now + Math.max(retryAfterMs ?? 0, replyOutboxIntervalMs(attemptsAfterClaim))
  }
  return {
    kind: 'retry',
    disposition: classifyPeerRefusalCode(code),
    nextAttemptAfter,
    errorMessage
  }
}
