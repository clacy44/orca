// S10-16 C5, R18.5/R18.8: the pure classification half of the pump's catch block — split out of
// reply-outbox-pump.ts to stay under the max-lines ratchet. Reads exactly the closed-enumeration
// fields R18.8 names (error.code, error.data.retryAfterMs) and returns a disposition; the pump
// applies it (the DB writes, the notice) — no I/O happens in this file.
import { OrchestrationError } from './orchestration-error'
import { replyOutboxIntervalMs, applyReplyOutboxJitter } from './reply-outbox-store'
import { classifyPeerRefusalCode, type ReplyRelayNoticeCode } from './reply-outbox-health'
import {
  LINK_BINDING_RETRY_MIN_MS,
  LINK_BINDING_RETRY_MAX_MS,
  LINK_BINDING_CAPABILITY_TTL_MS,
  REPLY_OUTBOX_LAST_ERROR_DETAIL_CLAMP,
  REPLY_RELAY_PEER_RECEIPT_POISONED_NOTICE,
  REPLY_RELAY_ID_CONFLICT_NOTICE,
  REPLY_RELAY_REFUSED_NOTICE,
  REPLY_RELAY_STALE_PAIRING_NOTICE,
  REPLY_RELAY_UNSUPPORTED_NOTICE
} from './link-binding-constants'

export type ReplyRelayErrorDisposition =
  | { kind: 'refused'; code: string; noticeCode: ReplyRelayNoticeCode; errorMessage: string }
  | {
      kind: 'retry'
      disposition: string
      nextAttemptAfter: number
      errorMessage: string
      // M9 (C5 review)/R18.5: most transport-shaped outcomes bump consecutive_failures; the
      // three rows below (a local pin re-check, a stale pairing, an unsupported peer) do not —
      // none of them is evidence the transport is unreachable.
      bumpFailure: boolean
      noticeCode?: ReplyRelayNoticeCode
    }
  // R18.5's `runtime_environment_changed` row: "no failure bump, immediate re-check ->
  // holdOrRetarget" — a distinct kind because it is dispositioned through the SAME re-check the
  // top of processItem already runs, never through retryReplyOutboxItem.
  | { kind: 'recheck'; errorMessage: string }

function clampRetryAfterMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    return null
  }
  return Math.min(Math.max(v, LINK_BINDING_RETRY_MIN_MS), LINK_BINDING_RETRY_MAX_MS)
}

// M11 (C5 review)/Ruling 26(k)/INV-P-006 clause (a): strip control characters and clamp length
// at the write site — raw, unbounded peer text is never stored in `last_error`.
function sanitizeErrorDetail(message: string): string {
  // eslint-disable-next-line no-control-regex -- Why: stripping raw peer-supplied control bytes is the point.
  const stripped = message.replace(/[\x00-\x1F\x7F]/g, ' ').trim()
  return stripped.slice(0, REPLY_OUTBOX_LAST_ERROR_DETAIL_CLAMP)
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
  const errorMessage = sanitizeErrorDetail(error instanceof Error ? error.message : String(error))

  if (KNOWN_REFUSAL_CODES.has(code)) {
    const noticeCode: ReplyRelayNoticeCode =
      code === 'operation_unknown'
        ? REPLY_RELAY_PEER_RECEIPT_POISONED_NOTICE
        : code === 'request_mismatch'
          ? REPLY_RELAY_ID_CONFLICT_NOTICE
          : REPLY_RELAY_REFUSED_NOTICE
    return { kind: 'refused', code, noticeCode, errorMessage }
  }

  // M9/R18.5: `runtime_environment_changed` — no failure bump, immediate re-check.
  if (code === 'runtime_environment_changed') {
    return { kind: 'recheck', errorMessage }
  }

  // Transport-shaped (or unknown/untyped): retry, with a bounded, jittered backoff
  // (R18.2/Ruling 26(i) — every backoff computed on this path is jittered).
  let nextAttemptAfter = now + applyReplyOutboxJitter(replyOutboxIntervalMs(attemptsAfterClaim))
  let bumpFailure = true
  let noticeCode: ReplyRelayNoticeCode | undefined

  if (code === 'stale_environment_pairing' || code === 'unauthorized') {
    // markPairingStale has already run in the transport layer (orca-runtime.ts) by the time this
    // error surfaces; this disposition only needs to avoid the failure bump and name the notice.
    bumpFailure = false
    noticeCode = REPLY_RELAY_STALE_PAIRING_NOTICE
  } else if (code === 'orchestration_migration_required' || code === 'capability_unsupported') {
    bumpFailure = false
    nextAttemptAfter = now + LINK_BINDING_CAPABILITY_TTL_MS
    noticeCode = REPLY_RELAY_UNSUPPORTED_NOTICE
  } else if (code === 'rate_limited') {
    const retryAfterMs = clampRetryAfterMs(
      (error as OrchestrationError | undefined)?.data &&
        typeof (error as OrchestrationError).data === 'object'
        ? ((error as OrchestrationError).data as { retryAfterMs?: unknown }).retryAfterMs
        : undefined
    )
    nextAttemptAfter =
      now +
      Math.max(retryAfterMs ?? 0, applyReplyOutboxJitter(replyOutboxIntervalMs(attemptsAfterClaim)))
  }
  return {
    kind: 'retry',
    disposition: classifyPeerRefusalCode(code),
    nextAttemptAfter,
    errorMessage,
    bumpFailure,
    noticeCode
  }
}
