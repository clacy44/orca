// S10-16 (design v6 APPENDIX A4, R21.6). The health-word union, its total precedence order, the
// `unavailable` reasons and the check-line attention set — all A4, all owned here (link-binding-
// constants.ts owns numbers; this module owns these word lists, per the chair briefing's THE
// REGISTER rule). `describeLinkBindingHealth`/`describeLinkBindingAttention` (the DB-reading
// functions R21.1 specifies) land in C6; this module carries the pure, DB-free half only.

// A4-01: twenty members, total.
export type LinkBindingHealth =
  | 'quarantined'
  | 'revoked'
  | 'excluded'
  | 'parked'
  | 'contested'
  | 'misroute_suspected'
  | 'peer_reports_contest'
  | 'peer_duplicate'
  | 'peer_no_environments'
  | 'duplicate_environment'
  | 'multi_grant'
  | 'unavailable'
  | 'unreachable'
  | 'unsupported'
  | 'stale'
  | 'legacy_unattested'
  | 'proven'
  | 'pending'
  | 'unpaired'
  | 'sender_unverified'

// A4-02: the precedence order, most-severe first. Total over LinkBindingHealth (lifecycle M3).
export const LINK_BINDING_HEALTH_PRECEDENCE: readonly LinkBindingHealth[] = [
  'quarantined',
  'revoked',
  'excluded',
  'parked',
  'contested',
  'misroute_suspected',
  'peer_reports_contest',
  'peer_duplicate',
  'peer_no_environments',
  'duplicate_environment',
  'multi_grant',
  'unavailable',
  'unreachable',
  'unsupported',
  'stale',
  'legacy_unattested',
  'proven',
  'pending',
  'unpaired',
  'sender_unverified'
]

// A4-05: seven `unavailable` reasons.
export type LinkBindingUnavailableReason =
  | 'transport'
  | 'prover'
  | 'self_view'
  | 'peer_self_view'
  | 'outbox'
  | 'peer_no_environments'
  | 'local_evidence'

export const LINK_BINDING_UNAVAILABLE_REASONS: readonly LinkBindingUnavailableReason[] = [
  'transport',
  'prover',
  'self_view',
  'peer_self_view',
  'outbox',
  'peer_no_environments',
  'local_evidence'
]

// A4-06, AS AMENDED BY RULING 23(c): the check-line attention set gains `unavailable` and
// `revoked` beyond R19.5's original four. `misroute_suspected` is deliberately NOT a member —
// its push surface is the (un-mutable, per Ruling 23(a)) authorship notice, a chair decision
// recorded in the C6 dispatch, not reopened here.
export const LINK_BINDING_ATTENTION_HEALTH: ReadonlySet<LinkBindingHealth> = new Set([
  'contested',
  'quarantined',
  'parked',
  'peer_reports_contest',
  'unavailable',
  'revoked'
])

// R21.6 clause 2: "the FIRST word in this list that applies" — the pure combine step, DB-free.
// Returns null on an empty candidate set (no link exists / nothing applies) rather than a
// fabricated default, so a caller cannot mistake "nothing observed" for a real health word.
export function worstLinkBindingHealth(
  candidates: readonly LinkBindingHealth[]
): LinkBindingHealth | null {
  for (const word of LINK_BINDING_HEALTH_PRECEDENCE) {
    if (candidates.includes(word)) {
      return word
    }
  }
  return null
}

// Render strings — the only place a health word becomes operator-facing prose. Kept short and
// factual; peer-sourced detail is layered on by `peer-supplied-text.ts` (C6), never inlined here.
const LINK_BINDING_HEALTH_LABELS: Record<LinkBindingHealth, string> = {
  quarantined: 'quarantined',
  revoked: 'revoked',
  excluded: 'excluded from scanning',
  parked: 'parked',
  contested: 'contested',
  misroute_suspected: 'misroute suspected',
  peer_reports_contest: 'peer reports contest',
  peer_duplicate: 'peer reports a duplicate grant',
  peer_no_environments: 'peer has no environments to offer',
  duplicate_environment: 'duplicate environment',
  multi_grant: 'multiple grants to one environment',
  unavailable: 'unavailable',
  unreachable: 'unreachable',
  unsupported: 'unsupported',
  stale: 'stale',
  legacy_unattested: 'legacy, unattested',
  proven: 'proven',
  pending: 'pending',
  unpaired: 'unpaired',
  sender_unverified: 'sender unverified'
}

export function renderLinkBindingHealth(word: LinkBindingHealth): string {
  return LINK_BINDING_HEALTH_LABELS[word]
}
