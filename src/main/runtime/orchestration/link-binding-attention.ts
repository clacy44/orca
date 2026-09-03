// S10-16 C6, R21.1/R21.6/R19.5 (Ruling 21 Protocol B2; Ruling 26 Addendum 2(z)/3(gg)):
// `describeLinkBindingHealth`/`describeLinkBindingAttention` — the DB-reading functions R21.1
// specifies. DEVIATION from plan §C6's file table (declared in the C6 commit body): the design
// places these in `src/shared/link-binding-health.ts`, but every other `src/shared/*` module in
// this tree is main-process-import-free (no `src/shared` file imports from `src/main`, verified
// by grep) so the CLI/renderer bundle never pulls in `OrcaRuntimeService`. R21.1's own signature
// (`describeLinkBindingHealth(db, runtime, linkDeviceId)`) needs `OrcaRuntimeService` and
// `OrchestrationDb`, both main-process types — so this module lives beside the other prover/
// pump orchestration modules instead, and `src/shared/link-binding-health.ts` keeps the
// pure, DB-free half (the union, precedence, attention-set, render strings) it already had.
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from './db'
import {
  LINK_BINDING_HEALTH_PRECEDENCE,
  LINK_BINDING_ATTENTION_HEALTH,
  worstLinkBindingHealth,
  renderLinkBindingHealth,
  type LinkBindingHealth
} from '../../../shared/link-binding-health'
import { getRoutableLinkBinding } from './link-binding-routable'
import { routingClassOf } from './link-binding-liveness'
import { describeReplyRelayLinkHealth } from './reply-outbox-health'
import { LINK_BINDING_REVERIFY_MS, LINK_BINDING_ATTEST_WARN_MS } from './link-binding-constants'
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

// R21.1: computed entirely from rows — never from a live prover object. R21.6: the word is the
// FIRST of the total precedence list that applies, over every candidate this link's rows raise.
export function describeLinkBindingHealth(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  linkDeviceId: string
): LinkBindingHealth {
  const now = Date.now()
  const binding = db.getPeerLinkBinding(linkDeviceId)
  const attempt = db.getBindingAttempt(linkDeviceId)
  const candidates: LinkBindingHealth[] = []

  if (db.isPeerLinkQuarantined(linkDeviceId)) {
    candidates.push('quarantined')
  }
  if (binding?.state === 'revoked') {
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

  switch (attempt?.lastOutcome) {
    case 'peer_duplicate':
    case 'duplicate_environment':
    case 'multi_grant':
    case 'unreachable':
    case 'unsupported':
    case 'unpaired':
      candidates.push(attempt.lastOutcome)
      break
    case 'unavailable':
    case 'protocol_violation':
      if (
        attempt.lastDetail?.includes('peer_no_environments') ||
        attempt.lastDetail === 'link_store_empty'
      ) {
        candidates.push('peer_no_environments')
      } else {
        candidates.push('unavailable')
      }
      break
    case 'proven': {
      const routes = getRoutableLinkBinding(db, runtime, linkDeviceId) !== null
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
  }

  const outboxRows = db.listReplyOutbox(linkDeviceId)
  const relayWord = describeReplyRelayLinkHealth(outboxRows)
  if (relayWord) {
    candidates.push(relayWord)
  }

  return worstLinkBindingHealth(candidates) ?? 'pending'
}

function resolveEnvironmentName(runtime: OrcaRuntimeService, environmentId: string): string {
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
  attestationExpired: boolean
  attestationExpiring: boolean
}

// R19.5/Ruling 21 Protocol B2/A4-06: the ONE additive `orca orchestration check` line. Null unless
// at least one link's health word is in the attention set OR a live `accept_legacy` attestation is
// inside its warn window of expiry or past it (a distinct trigger — routingClass alone would read
// `legacy_unattested`/`proven`, neither of which is in the attention set).
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

  const candidates: AttentionCandidate[] = []
  for (const linkDeviceId of linkIds) {
    const binding = db.getPeerLinkBinding(linkDeviceId)
    const word = describeLinkBindingHealth(db, runtime, linkDeviceId)
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
    const inAttentionSet = LINK_BINDING_ATTENTION_HEALTH.has(word)
    if (inAttentionSet || attestationExpired || attestationExpiring) {
      candidates.push({
        linkDeviceId,
        environmentId: binding?.environmentId ?? null,
        word: inAttentionSet ? word : null,
        attestationExpired,
        attestationExpiring
      })
    }
  }

  if (candidates.length === 0) {
    return null
  }

  // Rank: health-attention words by A4-02 precedence, then attestation-expired, then
  // attestation-expiring (declared placement — A4-06 names the trigger, not its rank among the
  // six health words; C6 commit body).
  const rank = (c: AttentionCandidate): number => {
    if (c.word) {
      return LINK_BINDING_HEALTH_PRECEDENCE.indexOf(c.word)
    }
    return LINK_BINDING_HEALTH_PRECEDENCE.length + (c.attestationExpired ? 0 : 1)
  }
  const worst = candidates.reduce((a, b) => (rank(b) < rank(a) ? b : a))

  const label = worst.word
    ? renderLinkBindingHealth(worst.word)
    : worst.attestationExpired
      ? 'attestation expired'
      : 'attestation expiring'
  const claimed = worst.word && PEER_SOURCED_HEALTH_WORDS.has(worst.word)
  const wordLabel = claimed ? labelPeerSuppliedClaim(label) : label
  const environmentName = resolveEnvironmentName(runtime, worst.environmentId ?? worst.linkDeviceId)

  return (
    `Link binding needs attention: ${candidates.length} ${wordLabel} (${environmentName}) — ` +
    `orca environment link-status`
  )
}
