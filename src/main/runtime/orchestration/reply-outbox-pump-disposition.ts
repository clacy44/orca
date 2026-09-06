// S10-16 C5, R18.5/R18.8: the pure classification half of the pump's catch block — split out of
// reply-outbox-pump.ts to stay under the max-lines ratchet. Reads exactly the closed-enumeration
// fields R18.8 names (error.code, error.data.retryAfterMs) and returns a disposition; the pump
// applies it (the DB writes, the notice) — no I/O happens in this file.
import { OrchestrationError } from './orchestration-error'
import { replyOutboxIntervalMs, applyReplyOutboxJitter, type RelayKind } from './reply-outbox-store'
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
// Ruling 28(f) (C8a): exported — the ONE permitted edit to a pump file this clause makes —
// so `link-status --outbox` (orchestration-link-binding-local.ts) can render the same
// write-time-sanitized text under the R19.4 label, rather than dumping raw peer-supplied bytes.
export function sanitizeErrorDetail(message: string): string {
  // Ruling 26 Addendum 1(v)/F9: also strips U+2028/U+2029 — JS string line terminators that
  // survive a JSON round-trip (R19.4's set).
  // eslint-disable-next-line no-control-regex -- Why: stripping raw peer-supplied control bytes is the point.
  const stripped = message.replace(/[\x00-\x1F\x7F\u2028\u2029]/g, ' ').trim()
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

// S10-21b B5 (design §2.6(a)): for a PACT item only (`relay_kind !== 'reply'`), these four causes
// are repairable (re-register, a quarantine lift, dial-time re-resolution) — hold via the retry
// path (bumpFailure:false) instead of KNOWN_REFUSAL_CODES' terminal 'refused', bounded by
// PACT_RELAY_HOLD_MAX_MS once `retryReplyOutboxItem`'s own first_held_at stamp (below) gives that
// bound a clock to read (the bound-check-then-terminal-settle itself is commit 9's job — this
// function only classifies the bucket). Checked BEFORE KNOWN_REFUSAL_CODES, which these four
// codes also belong to, so a pact item never falls through to the terminal branch.
// S10-21b B9b (design §2.6(c)): exported so the pump's retry branch can bound a held pact row's
// four repairable causes at PACT_RELAY_HOLD_MAX_MS without re-deriving the set or adding a clock
// to this pure classifier (21b-G1) — the set itself is untouched.
export const PACT_HOLD_CAUSES = new Set([
  'agent_retired',
  'agent_unknown',
  'derived_agent_unaddressable',
  'agent_quarantined'
])

// S10-21b B5 (design §2.9): none of these is evidence the transport is unreachable — retry,
// bumpFailure:false, same growing-backoff derivation as PACT_HOLD_CAUSES above.
// S10-21b B11 (design §3.3, SCOPE item 5): `pact_paused` added — the peer refusing an inbound
// apply because ITS OWN copy of the pact is paused (e.g. the link-evidence auto-pause, commit
// 15) is not evidence THIS host's transport is unreachable either; it was previously
// unclassified here and fell through to the default bumpFailure:true branch, contradicting the
// design's explicit "stays out of bumpFailure treatment the same way pact_settling/
// pact_out_of_order do" (§3.3).
const PACT_RETRY_CAUSES = new Set([
  'pact_settling',
  'pact_out_of_order',
  'pact_identity_unmirrored',
  'pact_ledger_capped',
  'pact_paused'
])

// S10-21b B5 (design §2.9): deterministic on the same bytes, or a genuine protocol fault —
// terminal for a pact item. The other terminal pact-item codes (body_gate_refused,
// request_mismatch, not_the_addressee, invalid_argument, operation_unknown) are already terminal
// via KNOWN_REFUSAL_CODES above for every relay kind; these three are net-new codes this slice
// introduces and have no mail-path meaning.
const PACT_TERMINAL_ONLY_CAUSES = new Set(['pact_desync', 'pact_era_mismatch', 'pact_no_pact'])

// R18.5's disposition table + R18.8's closed error read, as one pure function.
// Ruling 26 Addendum 1(r)/F5: the backoff curve's input is the row's persisted
// consecutive_failures — the same counter the claim (reply-outbox-lifecycle.ts) and the
// unreachable/recovered edge use — never `attempts` (parameter renamed from `attemptsAfterClaim`).
export function classifyReplyRelayError(
  error: unknown,
  consecutiveFailures: number,
  now: number,
  // S10-21b B5: defaulted so every pre-existing (mail) call site is byte-identical — the pact
  // branch below never runs for 'reply'.
  relayKind: RelayKind = 'reply',
  // S10-21b B5 (design §2.9): the pact retry/hold backoff is derived from the item's own
  // `attempts` (bumped on every claim), never `consecutiveFailures` — bumpFailure is always false
  // for these causes, so consecutiveFailures alone would never grow the interval.
  attempts = 0
): ReplyRelayErrorDisposition {
  const errorCode = (error as { code?: unknown } | null)?.code
  const code =
    error instanceof OrchestrationError
      ? error.code
      : typeof errorCode === 'string'
        ? errorCode
        : 'unknown_peer_refusal'
  const errorMessage = sanitizeErrorDetail(error instanceof Error ? error.message : String(error))

  if (relayKind !== 'reply') {
    if (PACT_TERMINAL_ONLY_CAUSES.has(code)) {
      return { kind: 'refused', code, noticeCode: REPLY_RELAY_REFUSED_NOTICE, errorMessage }
    }
    if (PACT_HOLD_CAUSES.has(code) || PACT_RETRY_CAUSES.has(code)) {
      return {
        kind: 'retry',
        disposition: code,
        nextAttemptAfter: now + applyReplyOutboxJitter(replyOutboxIntervalMs(attempts)),
        errorMessage,
        bumpFailure: false
      }
    }
  }

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
  let nextAttemptAfter = now + applyReplyOutboxJitter(replyOutboxIntervalMs(consecutiveFailures))
  let bumpFailure = true
  let noticeCode: ReplyRelayNoticeCode | undefined

  if (code === 'stale_environment_pairing' || code === 'unauthorized') {
    // Ruling 26 Addendum 1(u)/F8: R18.5's table has NO exemption for this row — only
    // runtime_environment_changed and the two local-scheduling rows skip the bump. markPairingStale
    // has already run in the transport layer (orca-runtime.ts); that is orthogonal to whether this
    // is evidence of a failed attempt. bumpFailure stays true so a permanently-unauthorized route
    // reaches REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD and the `unreachable` health word.
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
      Math.max(
        retryAfterMs ?? 0,
        applyReplyOutboxJitter(replyOutboxIntervalMs(consecutiveFailures))
      )
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
