// S10-16 (Ruling 23, chair briefing §0 decision 1): THE REGISTER — the single definition site for
// every number, code list and word list this slice owns (design v6 APPENDIX A). No other file in
// `src/main/runtime/orchestration/link-binding-*`, `src/main/runtime/rpc/methods/orchestration-link-
// binding-*`, `src/shared/link-binding-health.ts` or `src/cli/handlers/environment-link-binding.ts`
// may write a numeric literal or duplicate one of these unions — every consumer imports the symbol
// (test: link-binding-constants.test.ts, the rewritten test 77).

import { createHash } from 'node:crypto'

// --- A1: constants this slice owns -----------------------------------------------------------

export const LINK_BINDING_PROBE_SLOTS = 8
// C3 (review F11): byte/char lengths for the proof module's hex/base64url shape guards and nonce
// sizes — THE REGISTER owns these too (link-binding-proof.ts builds its regexes from these via
// `new RegExp`, never an inline quantifier, so test 77's scan has nothing to catch there). No
// APPENDIX A row of their own; C3 is their one definition site.
// A1-45: hex-string length of a 16-byte (128-bit) value — the quarantine incident id
// (deriveLinkQuarantineIncidentId, below) truncates its sha256 digest to this many hex chars.
export const LINK_BINDING_HEX32_LENGTH = 32
// A1-46: hex-string length of a 32-byte (256-bit) value — every proof/confirm/selector MAC.
export const LINK_BINDING_HEX64_LENGTH = 64
// A1-47: sha256 digest as unpadded base64url.
export const LINK_BINDING_B64URL_SHA256_LENGTH = 43
// A1-48: nonceP's byte width (R7.3 step 9) — a DIFFERENT 32 from LINK_BINDING_HEX32_LENGTH above
// (bytes vs. hex chars; conflating the two was review F11's finding). The incident id's hex
// length is LINK_BINDING_HEX32_LENGTH, never this constant.
export const LINK_BINDING_NONCE_BYTES = 32
export const LINK_BINDING_MAX_PAGES_PER_ROUND = 1
export const LINK_BINDING_SCAN_CONCURRENCY = 4
export const LINK_BINDING_RPC_BUDGET_MS = 12_000
// A-arith(1): 5 x RPC_BUDGET — capability + probe + re-probe + confirm (4 calls) plus one call of
// slack, so a healthy winner on a cold cache (4 x 12_000 = 48_000) is never cut off.
export const LINK_BINDING_CANDIDATE_BUDGET_MS = 60_000
// A1-06/P16: LINK_BINDING_ROUND_BUDGET_MS is NOT a constant — it is computed per round in
// link-binding-schedule.ts from LINK_BINDING_CANDIDATE_BUDGET_MS, the round's own candidate-
// environment count and LINK_BINDING_ROUND_BUDGET_CAP_MS (A-arith(2)).
export const LINK_BINDING_ROUND_BUDGET_CAP_MS = 120_000
export const LINK_BINDING_MAX_ROUNDS_PER_MIN = 4
// A-arith(4): 60_000 / MAX_ROUNDS_PER_MIN — also the bucket's refill period.
export const LINK_BINDING_MIN_KICK_INTERVAL_MS = 15_000
export const LINK_BINDING_INFLIGHT_GRACE_MS = 5_000
export const LINK_BINDING_SWEEP_MS = 60_000
// A-arith(3): PROBE_TTL > ROUND_BUDGET_CAP > SWEEP >= CANDIDATE_BUDGET > RPC_BUDGET.
export const LINK_BINDING_PROBE_TTL_MS = 180_000
// A-arith(6): SCAN_CONCURRENCY x phases(2) x TTL/sweep overlap(2).
export const LINK_BINDING_PENDING_PER_LINK = 16
export const LINK_BINDING_PENDING_ALARM = 512
// A-arith(5): rate-limit headroom depends on D (distinct grants) staying 1 via the R10-B collapse.
export const LINK_BINDING_RATE_LIMIT = 60
export const LINK_BINDING_RATE_WINDOW_MS = 60_000
// Ruling 23(f): the derived value, corrected from v6's stated 60 (A-arith(7): 2 x PEER_ASK_PENDING_CAP(32)).
export const FEDERATED_ASK_RATE_LIMIT = 64
// A-arith(7): REPLY_OUTBOX_PER_LINK_CAP — the largest legitimate single-link burst.
export const FEDERATED_SEND_RATE_LIMIT = 256
export const LINK_BINDING_CAPABILITY_TTL_MS = 3_600_000
export const LINK_BINDING_BACKOFF_BASE_MS = 30_000
export const LINK_BINDING_BACKOFF_MAX_MS = 1_800_000
export const LINK_BINDING_KICK_DEBOUNCE_MS = 2_000
export const LINK_BINDING_STARTUP_DELAY_MS = 5_000
export const LINK_BINDING_UNPAIRED_PARK_ROUNDS = 3
export const LINK_BINDING_PARK_REARM_MS = 21_600_000
// Also the scan-fact TTL (R12.1(3)): "how long a claim may stand unobserved."
export const LINK_BINDING_REVERIFY_MS = 86_400_000
// Ruling 17(o).
export const LINK_BINDING_LEGACY_ATTEST_TTL_MS = 604_800_000
// A-arith: one LINK_BINDING_REVERIFY_MS of warning before LINK_BINDING_LEGACY_ATTEST_TTL_MS expiry.
export const LINK_BINDING_ATTEST_WARN_MS = 86_400_000
export const LINK_BINDING_PARTIAL_RETRY_MS = 900_000
// A-arith(11): STATUS_WAIT_CAP_MS + CLIENT_MARGIN_MS = 55_000 < the CLI's 60_000 socket default.
export const LINK_BINDING_STATUS_POLL_MS = 500
export const LINK_BINDING_STATUS_WAIT_CAP_MS = 45_000
export const LINK_BINDING_STATUS_CLIENT_MARGIN_MS = 10_000
// C7: `environment-link-binding.ts`'s relative-time rendering ("just now" / "Ns ago" / …) — THE
// REGISTER owns these too, per test 77's scan of that file.
export const LINK_BINDING_STATUS_MS_PER_SECOND = 1_000
export const LINK_BINDING_STATUS_SECONDS_PER_MINUTE = 60
export const LINK_BINDING_STATUS_SECONDS_PER_HOUR = 3_600
export const LINK_BINDING_ROWS_CAP = 512
export const LINK_BINDING_SCAN_FACTS_CAP = 4_096
export const LINK_BINDING_CONFIRM_OBS_PER_LINK_CAP = 64
export const LINK_BINDING_MISROUTE_ADVISORY_ALARM = 3
export const LINK_BINDING_PEER_TEXT_CLAMP = 512
// F13/Ruling 27 (C6a): the check attention line's interpolated environment name is
// operator-chosen, not peer-chosen, but unclamped it is one long name away from an unwieldy
// line. FORCED registration here (not a ruling-named constant) — test 77/THE REGISTER bans any
// numeric literal in link-binding-attention.ts outside this file; declared in the C6a commit body.
export const LINK_BINDING_ATTENTION_ENVIRONMENT_NAME_CLAMP = 200
// A-arith(9): the band equals the outbox backoff's own floor and cap.
export const LINK_BINDING_RETRY_MIN_MS = 5_000
export const LINK_BINDING_RETRY_MAX_MS = 300_000
// A-arith(8): also R18.6's kick floor (protocol B1).
export const REPLY_OUTBOX_BASE_MS = 5_000
export const REPLY_OUTBOX_MAX_MS = 300_000
export const REPLY_OUTBOX_JITTER_RATIO = 0.2
// A-arith(9): failuresToOutlast(600_000) over the backoff curve, real loop shape (starts at 1).
export const REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD = 7
export const REPLY_OUTBOX_LEASE_GRACE_MS = 5_000
export const REPLY_OUTBOX_HOLD_INTERVAL_MS = 30_000
export const REPLY_OUTBOX_HOLD_MAX_MS = 900_000
export const REPLY_OUTBOX_MAX_AGE_MS = 604_800_000
export const REPLY_OUTBOX_MAX_BYTES = 65_536
export const REPLY_OUTBOX_PER_LINK_CAP = 256
export const REPLY_OUTBOX_LINK_CONCURRENCY = 4
// A-arith(10): matches the existing relay timeout; passed as both timeoutMs and maxDurationMs.
export const REPLY_OUTBOX_RPC_BUDGET_MS = 30_000
export const REPLY_OUTBOX_KICK_DEBOUNCE_MS = 1_000
// M11 (C5 review)/Ruling 26(k)/INV-P-006 clause (a): the write-time cap on a stored
// `peer_reply_outbox.last_error` detail — raw peer text is never stored beyond this bound.
export const REPLY_OUTBOX_LAST_ERROR_DETAIL_CLAMP = 512
// Existing constants, owned by device-registry-pending-grants.ts (the base tree, pre-S10-16) —
// re-exported here, never redeclared, so this slice's consumers still get them from THE REGISTER
// without creating a second definition site (F4/L-2). MAX_LIVE_MINTED_GRANTS is newly partitioned
// by (scope, budgetClass) per R1.1; PENDING_GRANT_TTL_MS is unchanged.
export { MAX_LIVE_MINTED_GRANTS, PENDING_GRANT_TTL_MS } from '../device-registry-pending-grants'

// --- A2: counts and structural numbers --------------------------------------------------------

export const SCHEMA_VERSION_LINK_BINDING = 40

// A2-04/L-9/X3: the ONE site for resetAll()'s exempt-table list — db.ts and any doc reference it.
export const A2_RESET_EXEMPT_TABLES = [
  'peer_link_bindings',
  'peer_link_attempts',
  'peer_link_scan_facts',
  'peer_link_containment'
] as const

// A2-02: never dropped by the unshipped-v40 repair.
export const A2_NEVER_DROPPED_TABLES = [
  'peer_link_bindings',
  'peer_link_containment',
  'peer_reply_outbox'
] as const

// A2-03: dropped-and-recreated by the unshipped-v40 repair — genuinely re-derivable state.
export const A2_DROP_AND_RECREATE_TABLES = [
  'peer_link_attempts',
  'peer_link_scan_facts',
  'peer_link_confirm_observations'
] as const

// --- A3: refusal and disposition codes ----------------------------------------------------------

export const LINK_BINDING_CONFLICT_CODE = 'link_binding_conflict'
export const LINK_STORE_UNREADABLE_CODE = 'link_store_unreadable'
export const LINK_STORE_EMPTY_CODE = 'link_store_empty'

export const LOCAL_EVIDENCE_UNAVAILABLE_CODE = 'local_evidence_unavailable'
export const AUTHORSHIP_UNCONFIRMED_CODE = 'authorship_unconfirmed'
export const CANCELLED_LOCAL_RESET_CODE = 'cancelled_local_reset'
export const BINDING_CHANGED_CODE = 'binding_changed'
// Ruling 26 Addendum 5(mm): the same-route hold's honest word — the peer-returned disposition
// (runtime_environment_changed), never BINDING_CHANGED_CODE, while the host's route is unchanged.
export const RUNTIME_ENVIRONMENT_CHANGED_CODE = 'runtime_environment_changed'
export const ROUTE_MOVED_CODE = 'route_moved'
export const UNKNOWN_PEER_REFUSAL_CODE = 'unknown_peer_refusal'
// Ruling 26(j): the in-flight-registry collision hold's own code — distinct from
// LOCAL_EVIDENCE_UNAVAILABLE_CODE (a different local-scheduling cause) and never ''.
export const REPLY_RELAY_COLLISION_CODE = 'relay_dial_collision'
// Ruling 26(e): a peer's federatedSend receipt failed the host id grammar — settled `delivered`
// (the peer accepted the reply; retrying would double-deliver) with the peer ids NULL.
export const PEER_RESULT_MALFORMED_CODE = 'peer_result_malformed'
// Ruling 26(g): a throw from post-delivery bookkeeping (after a successful settle) — never a
// transport failure, never a retry of a delivered row.
export const REPLY_RELAY_BOOKKEEPING_FAILED_CODE = 'reply_relay_bookkeeping_failed'
// Ruling 28(j): the v40 outbox repair's CHECK-rejection fallback (db.ts) — the row's `state`
// write to 'abandoned' was itself rejected by a pre-review build's CHECK constraint, so the
// fallback settles the row terminal (settled_at stamped) through the columns no CHECK
// constrains, WITHOUT lying about the reason via the primary path's own
// 'incomplete_row_fail_closed' code.
export const REPLY_OUTBOX_REPAIR_REJECTED_CODE = 'repair_rejected'

export const REPLY_RELAY_UNREACHABLE_NOTICE = 'reply_relay_unreachable'
export const REPLY_RELAY_RECOVERED_NOTICE = 'reply_relay_recovered'
export const REPLY_RELAY_ABANDONED_NOTICE = 'reply_relay_abandoned'
export const REPLY_RELAY_REFUSED_NOTICE = 'reply_relay_refused'
export const REPLY_RELAY_ROUTE_MOVED_NOTICE = 'reply_relay_route_moved'
export const REPLY_RELAY_PEER_RECEIPT_POISONED_NOTICE = 'reply_relay_peer_receipt_poisoned'
export const REPLY_RELAY_ID_CONFLICT_NOTICE = 'reply_relay_id_conflict'
export const REPLY_RELAY_AUTHORSHIP_UNCONFIRMED_NOTICE = 'reply_relay_authorship_unconfirmed'
// M9 (C5 review)/Ruling 26(i): the two R18.5 notices the review found unimplemented.
export const REPLY_RELAY_STALE_PAIRING_NOTICE = 'reply_relay_stale_pairing'
export const REPLY_RELAY_UNSUPPORTED_NOTICE = 'reply_relay_unsupported'
export const LINK_BINDING_CONTESTED_NOTICE = 'link_binding_contested'
export const LINK_BINDING_UNAVAILABLE_NOTICE = 'link_binding_unavailable'
export const LINK_BINDING_PEER_REPORTS_CONTEST_NOTICE = 'link_binding_peer_reports_contest'
export const LINK_BINDING_ATTESTATION_EXPIRING_NOTICE = 'link_binding_attestation_expiring'
export const LINK_BINDING_ATTESTATION_EXPIRED_NOTICE = 'link_binding_attestation_expired'

// --- A4: the schema v40 outcome/word lists (also re-exported by link-binding-health.ts) --------

// peer_link_bindings.state (three), peer_link_bindings.grant_class, .scan_completeness.
export const LINK_BINDING_STATES = ['confirmed', 'contested', 'revoked'] as const
export const LINK_BINDING_GRANT_CLASSES = ['minted', 'legacy_coalesced'] as const
export const LINK_BINDING_SCAN_COMPLETENESS = ['complete', 'partial'] as const

// peer_link_attempts.last_outcome — exactly fifteen members, ONE writer (the round settle).
export const LINK_BINDING_LAST_OUTCOMES = [
  'pending',
  'proven',
  'unpaired',
  'unpaired_parked',
  'peer_duplicate',
  'duplicate_environment',
  'multi_grant',
  'contested',
  'unreachable',
  'unsupported',
  'unavailable',
  'protocol_violation',
  'quarantined',
  'revoked',
  'excluded'
] as const

// peer_link_scan_facts.outcome — exactly seven members (C2 amendment (ii), Ruling 23(d): NO
// `duplicate_environment` — the collapse writes no scan fact).
export const LINK_BINDING_SCAN_FACT_OUTCOMES = [
  'no_match',
  'proven',
  'peer_duplicate',
  'protocol_violation',
  'unsupported',
  'unavailable',
  'unreachable'
] as const

// peer_link_confirm_observations.kind.
export const LINK_BINDING_CONFIRM_OBSERVATION_KINDS = ['peer_confirmed', 'local_duplicate'] as const

// peer_link_containment.subject_kind / .action.
export const LINK_BINDING_CONTAINMENT_SUBJECT_KINDS = ['link', 'environment'] as const
export const LINK_BINDING_CONTAINMENT_ACTIONS = [
  'quarantine',
  'scan_exclude',
  'accept_legacy'
] as const

// peer_reply_outbox.state.
export const REPLY_OUTBOX_STATES = [
  'queued',
  'sending',
  'delivered',
  'refused',
  'abandoned',
  'cancelled'
] as const

// --- A5: derived-id formulas — single definition site, formula frozen by C3 --------------------

// Lifecycle m4: the incident id for a link-quarantine refusal (R3). Deterministic per quarantine
// "generation" — a lift + re-assert is a new row-content generation and yields a new id, which is
// correct: it is a new incident from the peer's point of view. Every refusal path (probe/confirm
// in C3, federatedSend/federatedAsk in C2a) derives through this one function rather than
// re-implementing the formula; do not change it without re-deriving every caller's fixtures.
export function deriveLinkQuarantineIncidentId(
  linkDeviceId: string,
  quarantinedAt: number
): string {
  return createHash('sha256')
    .update(`${linkDeviceId}:${quarantinedAt}`)
    .digest('hex')
    .slice(0, LINK_BINDING_HEX32_LENGTH)
}
