// S10-16 C6/C6a, R21.1/R21.6/R19.5 (Ruling 21 Protocol B2; Ruling 26 Addendum 2(z)/3(gg);
// Ruling 27 — C6 fix-up): `describeLinkBindingHealth`/`describeLinkBindingAttention` — the
// DB-reading functions R21.1 specifies. DEVIATION from plan §C6's file table (declared in the C6
// commit body): the design places these in `src/shared/link-binding-health.ts`, but every other
// `src/shared/*` module in this tree is main-process-import-free (no `src/shared` file imports
// from `src/main`, verified by grep) so the CLI/renderer bundle never pulls in
// `OrcaRuntimeService`. R21.1's own signature (`describeLinkBindingHealth(db, runtime,
// linkDeviceId)`) needs `OrcaRuntimeService` and `OrchestrationDb`, both main-process types — so
// this module lives beside the other prover/pump orchestration modules instead, and
// `src/shared/link-binding-health.ts` keeps the pure, DB-free half (the union, precedence,
// attention-set, render strings) it already had.
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from './db'
import {
  LINK_BINDING_HEALTH_PRECEDENCE,
  LINK_BINDING_ATTENTION_HEALTH,
  worstLinkBindingHealth,
  renderLinkBindingHealth,
  type LinkBindingHealth,
  type LinkBindingUnavailableReason
} from '../../../shared/link-binding-health'
import {
  getRoutableLinkBinding,
  localEvidenceUnavailable,
  readEnvironmentSnapshot,
  type EnvironmentSnapshot
} from './link-binding-routable'
import { routingClassOf } from './link-binding-liveness'
import { describeReplyRelayLinkHealth } from './reply-outbox-health'
import {
  LINK_BINDING_REVERIFY_MS,
  LINK_BINDING_ATTEST_WARN_MS,
  LINK_BINDING_ATTENTION_ENVIRONMENT_NAME_CLAMP
} from './link-binding-constants'
import { PEER_SOURCED_HEALTH_WORDS, labelPeerSuppliedClaim } from './peer-supplied-text'

// R15.1's `liveLegacyAttestation` source, re-derived here rather than imported from
// link-binding-routable.ts's private `buildLivenessSources` — that function is not exported
// (Ruling 23(g): `isRoutableBindingRow` stays the ONE predicate; this is only the tiny data-access
// shim `routingClassOf` needs, not a second copy of the predicate itself).
function liveLegacyAttestation(
  db: OrchestrationDb,
  linkDeviceId: string,
  environmentId: string,
  peerKeyFingerprint: string,
  now: number
): boolean {
  const containment = db.getContainment('link', linkDeviceId, 'accept_legacy')
  if (!containment || containment.liftedAt !== null) {
    return false
  }
  if (containment.expiresAt !== null && containment.expiresAt <= now) {
    return false
  }
  if (!containment.detail) {
    return false
  }
  try {
    const detail = JSON.parse(containment.detail) as {
      environmentId?: string
      peerKeyFingerprint?: string
    }
    return (
      detail.environmentId === environmentId && detail.peerKeyFingerprint === peerKeyFingerprint
    )
  } catch {
    return false
  }
}

export type LinkBindingHealthResult = {
  word: LinkBindingHealth
  // Ruling 27(f)/plan §P-1: carried ONLY for `word === 'unavailable'`, so the line can render
  // `unavailable(local_evidence)`. F6's other three reasons (transport/prover/self_view) need a
  // public, side-effect-free nullness check on `OrcaRuntimeService` that does not exist on this
  // tree (`linkBindingProver` is a private lazily-armed field with no getter that doesn't also
  // construct it; `orchestrationEnvironmentTransport` is fully private) — declared residual,
  // out of this file's scope (orca-runtime.ts is not in the C6a file list).
  reason?: LinkBindingUnavailableReason
}

// R21.1: computed entirely from rows — never from a live prover object. R21.6: the word is the
// FIRST of the total precedence list that applies, over every candidate this link's rows raise.
export function describeLinkBindingHealth(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  linkDeviceId: string,
  // S10-16 C6a, Ruling 27(b): defaults to a fresh read for any caller besides
  // `describeLinkBindingAttention` (which hoists ONE read for the whole call and passes it here
  // for every link).
  snapshot: EnvironmentSnapshot = readEnvironmentSnapshot()
): LinkBindingHealthResult {
  const now = Date.now()
  const binding = db.getPeerLinkBinding(linkDeviceId)
  const attempt = db.getBindingAttempt(linkDeviceId)
  const candidates: LinkBindingHealth[] = []
  let unavailableReason: LinkBindingUnavailableReason | undefined

  if (db.isPeerLinkQuarantined(linkDeviceId)) {
    candidates.push('quarantined')
  }
  // F7/Ruling 27(e): `revoked_at` is the load-bearing half of the revocation mark (db.ts's own
  // repair-fallback comment) — a row revoked through the CHECK-rejection catch branch stamps
  // `revoked_at` alone, so keying on `state` misses it and the fail-closed repair's own fallback
  // renders invisible.
  if (binding?.state === 'revoked' || binding?.revokedAt != null) {
    candidates.push('revoked')
  }
  const excludeRow = db.getContainment('link', linkDeviceId, 'scan_exclude')
  if (
    excludeRow &&
    excludeRow.liftedAt === null &&
    (excludeRow.expiresAt === null || excludeRow.expiresAt > now)
  ) {
    candidates.push('excluded')
  }
  if (attempt?.lastOutcome === 'unpaired_parked') {
    candidates.push('parked')
  }
  if (binding?.state === 'contested') {
    candidates.push('contested')
  }
  const advisory = attempt?.lastAdvisory ?? null
  const advisoryAt = attempt?.lastAdvisoryAt ?? null
  if (advisory && advisoryAt !== null && now - advisoryAt < LINK_BINDING_REVERIFY_MS) {
    if (advisory.kind === 'authorship_unconfirmed') {
      candidates.push('misroute_suspected')
    }
    if (advisory.kind === 'peer_reports_contest') {
      candidates.push('peer_reports_contest')
    }
  }

  // F6/Ruling 27(f): a wiring-level `unavailable` — this host's own registry or environment-store
  // evidence, not a stored attempt outcome — computed BEFORE the switch so it applies regardless
  // of what the last attempt happened to record (R21.1's original symptom: a host where the
  // prover never armed reads `pending`, silently, forever).
  if (localEvidenceUnavailable(runtime, snapshot)) {
    candidates.push('unavailable')
    unavailableReason = 'local_evidence'
  }

  switch (attempt?.lastOutcome) {
    case 'peer_duplicate':
    case 'duplicate_environment':
    case 'multi_grant':
    case 'unreachable':
    case 'unsupported':
    case 'unpaired':
      candidates.push(attempt.lastOutcome)
      break
    // F15: `protocol_violation` — H's own classification of a malformed peer response (plan
    // §4.7) — is DECLARED here to render as `unavailable`: R21.2's `unavailable` remedies all
    // point the operator at LOCAL wiring, which is a defensible fail-loud choice for a
    // malformed-response fault, but it is not literally what either code means. C7 may render it
    // with its own distinct reason instead.
    case 'unavailable':
    case 'protocol_violation':
      // F14: equality, not substring — a detail-format change must never accidentally demote a
      // link out of the attention set (`unavailable` is a member; `peer_no_environments` outranks
      // it but is NOT a member, A4-01/A4-06).
      if (
        attempt.lastDetail === 'peer_no_environments' ||
        attempt.lastDetail === 'link_store_empty'
      ) {
        candidates.push('peer_no_environments')
      } else {
        candidates.push('unavailable')
      }
      break
    case 'proven': {
      const routes = getRoutableLinkBinding(db, runtime, linkDeviceId, {}, snapshot) !== null
      if (routes) {
        candidates.push('proven')
      } else if (binding) {
        const routingClass = routingClassOf(
          binding,
          { liveLegacyAttestation: (l, e, k, n) => liveLegacyAttestation(db, l, e, k, n) },
          now
        )
        candidates.push(routingClass === 'legacy_unattested' ? 'legacy_unattested' : 'stale')
      } else {
        candidates.push('stale')
      }
      break
    }
    // These outcomes are already reflected by the containment/binding/advisory candidates above
    // (quarantined/revoked/excluded/parked/contested); an attempt row that never won a round, or
    // does not exist yet, is 'pending'.
    case 'quarantined':
    case 'revoked':
    case 'excluded':
    case 'unpaired_parked':
    case 'contested':
    case 'pending':
    case undefined:
      candidates.push('pending')
      break
    // F17: this repo's own `switch-exhaustiveness-check` type-aware lint rule (config/oxlint-
    // code-quality-type-aware.json) already fails the BUILD if a sixteenth `LinkBindingLastOutcome`
    // member is added without a case here — it flags an explicit `default:` on an exhaustive
    // switch as an ERROR (dead code), so a hand-written `never`-typed guard is redundant with,
    // and rejected by, a stronger existing control. No further code change closes this finding.
  }

  // F2/Ruling 27(b): bounded accessor — state-filtered, column-limited, LIMIT'd to the per-link
  // register cap; the check path never reads `payload` or a settled row past its attention window.
  const outboxRows = db.listReplyOutboxHealthRows(linkDeviceId, now)
  const relayWord = describeReplyRelayLinkHealth(outboxRows, now)
  if (relayWord) {
    candidates.push(relayWord)
  }

  const word = worstLinkBindingHealth(candidates) ?? 'pending'
  return word === 'unavailable' ? { word, reason: unavailableReason } : { word }
}

// F16: label a link with no environment (a quarantine-only link, no binding row) as a link id,
// never as a bare device id passed off as an environment name.
function resolveEnvironmentName(
  runtime: OrcaRuntimeService,
  environmentId: string | null,
  linkDeviceId: string
): string {
  if (environmentId === null) {
    return `link ${linkDeviceId}`
  }
  try {
    return runtime.resolveOrchestrationWorkerServer(environmentId).name
  } catch {
    return environmentId
  }
}

type AttentionCandidate = {
  linkDeviceId: string
  environmentId: string | null
  word: LinkBindingHealth | null
  reason?: LinkBindingUnavailableReason
  attestationExpired: boolean
  attestationExpiring: boolean
}

function attentionRank(c: AttentionCandidate): number {
  if (c.word) {
    return LINK_BINDING_HEALTH_PRECEDENCE.indexOf(c.word)
  }
  // Rank: health-attention words by A4-02 precedence, then attestation-expired, then
  // attestation-expiring (declared placement — A4-06 names the trigger, not its rank among the
  // health words; C6 commit body).
  return LINK_BINDING_HEALTH_PRECEDENCE.length + (c.attestationExpired ? 0 : 1)
}

function attentionGroupKey(c: AttentionCandidate): string {
  return c.word ?? (c.attestationExpired ? 'attestation_expired' : 'attestation_expiring')
}

function attentionGroupLabel(c: AttentionCandidate): string {
  const raw = c.word
    ? renderLinkBindingHealth(c.word) + (c.reason ? `(${c.reason})` : '')
    : c.attestationExpired
      ? 'attestation expired'
      : 'attestation expiring'
  const claimed = c.word && PEER_SOURCED_HEALTH_WORDS.has(c.word)
  return claimed ? labelPeerSuppliedClaim(raw) : raw
}

// R19.5/Ruling 21 Protocol B2/A4-06/Ruling 27(g): the ONE additive `orca orchestration check`
// line. Null unless at least one link's health word is in the attention set OR a live
// `accept_legacy` attestation is inside its warn window of expiry or past it (a distinct trigger
// — routingClass alone would read `legacy_unattested`/`proven`, neither of which is in the
// attention set).
export function describeLinkBindingAttention(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService
): string | null {
  const now = Date.now()
  const linkIds = new Set<string>()
  for (const row of db.listPeerLinkBindings()) {
    linkIds.add(row.linkDeviceId)
  }
  for (const row of db.listBindingAttempts()) {
    linkIds.add(row.linkDeviceId)
  }
  for (const row of db.listContainment()) {
    if (row.subjectKind === 'link') {
      linkIds.add(row.subjectId)
    }
  }

  // F2/Ruling 27(b): ONE environment-store read for the whole call, hoisted out of the per-link
  // loop below — threaded through every link's `describeLinkBindingHealth` call.
  const snapshot = readEnvironmentSnapshot()

  const candidates: AttentionCandidate[] = []
  for (const linkDeviceId of linkIds) {
    const binding = db.getPeerLinkBinding(linkDeviceId)
    const health = describeLinkBindingHealth(db, runtime, linkDeviceId, snapshot)
    const legacyRow = db.getContainment('link', linkDeviceId, 'accept_legacy')
    let attestationExpired = false
    let attestationExpiring = false
    if (legacyRow && legacyRow.liftedAt === null && legacyRow.expiresAt !== null) {
      if (legacyRow.expiresAt <= now) {
        attestationExpired = true
      } else if (legacyRow.expiresAt - now < LINK_BINDING_ATTEST_WARN_MS) {
        attestationExpiring = true
      }
    }
    const inAttentionSet = LINK_BINDING_ATTENTION_HEALTH.has(health.word)
    if (inAttentionSet || attestationExpired || attestationExpiring) {
      candidates.push({
        linkDeviceId,
        environmentId: binding?.environmentId ?? null,
        word: inAttentionSet ? health.word : null,
        reason: inAttentionSet ? health.reason : undefined,
        attestationExpired,
        attestationExpiring
      })
    }
  }

  if (candidates.length === 0) {
    return null
  }

  // F9/Ruling 27(g): the count is PER WORD ("1 contested, 1 quarantined"), never a merged count
  // rendered under only the worst word — that told the operator something false about the fleet.
  const groups = new Map<string, { label: string; count: number; rank: number }>()
  for (const c of candidates) {
    const key = attentionGroupKey(c)
    const existing = groups.get(key)
    if (existing) {
      existing.count += 1
    } else {
      groups.set(key, { label: attentionGroupLabel(c), count: 1, rank: attentionRank(c) })
    }
  }
  const ordered = [...groups.values()].sort((a, b) => a.rank - b.rank)
  const summary = ordered.map((g) => `${g.count} ${g.label}`).join(', ')

  const worst = candidates.reduce((a, b) => (attentionRank(b) < attentionRank(a) ? b : a))
  const environmentName = resolveEnvironmentName(
    runtime,
    worst.environmentId,
    worst.linkDeviceId
  ).slice(0, LINK_BINDING_ATTENTION_ENVIRONMENT_NAME_CLAMP)

  return (
    `Link binding needs attention: ${summary} (${environmentName}) — ` +
    `orca environment link-status`
  )
}
