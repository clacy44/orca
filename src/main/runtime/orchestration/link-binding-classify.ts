// S10-16 C4, R11 (design v6, frozen) + Ruling 23(d)/(e): the three-way classification rule and
// the R10-B/M2 credential-identical candidate collapse. Pure, no I/O — every input is already
// resolved by the caller (link-binding-prover-round.ts).

// R11.1 (Ruling 17(l)): auto-resolution ordering — newest createdAt wins, tie-broken by the
// environment id ascending (immutable keys only). Used both by classifyLinkRound (>=2 winners
// sharing one dstKeyFp) and by collapseCredentialIdenticalCandidates (R10-B, "applied one phase
// earlier").
function pickNewest<T extends { environmentId: string; createdAt: number }>(
  candidates: readonly T[]
): T {
  let best = candidates[0]
  if (!best) {
    throw new Error('pickNewest requires a non-empty array')
  }
  for (const candidate of candidates.slice(1)) {
    if (
      candidate.createdAt > best.createdAt ||
      (candidate.createdAt === best.createdAt && candidate.environmentId < best.environmentId)
    ) {
      best = candidate
    }
  }
  return best
}

export type LinkRoundCandidate = {
  environmentId: string
  createdAt: number
  peerCredentialFp: string
}

export type CredentialCollapseResult<T extends LinkRoundCandidate> = {
  kept: T[]
  // Ruling 23(d): the dropped record gets NO scan fact — it was not probed. The caller records
  // one line in `peer_link_attempts.last_detail` naming the survivor; it never touches
  // `peer_link_scan_facts`.
  dropped: { environmentId: string; survivorEnvironmentId: string }[]
}

// R10-B (v6, lifecycle M2) / R8.4's premise: group candidate environments by
// hashCallerCredential(resolveBoundEndpoint(e).deviceToken) — i.e. the SAME pairing credential —
// and keep only the newest by createdAt in each group, for the PROBE PASS only. A different grant
// to the same host has a different peer_credential_fp and survives (that is `multi_grant`, not
// this collapse).
export function collapseCredentialIdenticalCandidates<T extends LinkRoundCandidate>(
  candidates: readonly T[]
): CredentialCollapseResult<T> {
  const byCredential = new Map<string, T[]>()
  for (const candidate of candidates) {
    const group = byCredential.get(candidate.peerCredentialFp)
    if (group) {
      group.push(candidate)
    } else {
      byCredential.set(candidate.peerCredentialFp, [candidate])
    }
  }
  const kept: T[] = []
  const dropped: { environmentId: string; survivorEnvironmentId: string }[] = []
  for (const group of byCredential.values()) {
    if (group.length === 1) {
      const [only] = group
      if (only) {
        kept.push(only)
      }
      continue
    }
    const survivor = pickNewest(group)
    kept.push(survivor)
    for (const candidate of group) {
      if (candidate.environmentId !== survivor.environmentId) {
        dropped.push({
          environmentId: candidate.environmentId,
          survivorEnvironmentId: survivor.environmentId
        })
      }
    }
  }
  return { kept, dropped }
}

export type LinkRoundWinner = {
  environmentId: string
  createdAt: number
  boundEndpointId: string
  boundPairingRevision: number
  peerCredentialFp: string
  peerKeyFingerprint: string
}

export type LinkRoundClassification =
  | { outcome: 'unpaired' }
  // R11.2: a LABELLED REMOTE CLAIM — no winner, but >=1 environment answered `peer_duplicate`.
  | { outcome: 'peer_duplicate' }
  | { outcome: 'bind'; winner: LinkRoundWinner; detail: null }
  // one peer saved twice here — auto-resolve to the newest and bind.
  | { outcome: 'duplicate_environment'; winner: LinkRoundWinner; detail: string }
  // one peer, two distinct pairing grants — auto-resolve to the newest and bind.
  | { outcome: 'multi_grant'; winner: LinkRoundWinner; detail: string }
  // two distinct hosts hold one link credential — refuse both, no bind.
  | { outcome: 'contested'; detail: string }

// R11: the three-way rule. `winners` is W(L) — every environment that returned a VERIFIED proof
// for this link's slot this round; `peerDuplicateCount` is |D(L)| — the count of environments
// that answered `peer_duplicate` for this slot (R11.2).
export function classifyLinkRound(
  winners: readonly LinkRoundWinner[],
  peerDuplicateCount: number
): LinkRoundClassification {
  if (winners.length === 0) {
    return peerDuplicateCount >= 1 ? { outcome: 'peer_duplicate' } : { outcome: 'unpaired' }
  }
  if (winners.length === 1) {
    const [winner] = winners
    if (!winner) {
      return { outcome: 'unpaired' }
    }
    return { outcome: 'bind', winner, detail: null }
  }
  const keyFingerprints = new Set(winners.map((w) => w.peerKeyFingerprint))
  if (keyFingerprints.size > 1) {
    // R11.3: contest — refuse both, incumbent set 'contested'. Detail names every competing
    // environment and key fingerprint (rendered locally, never sent to a peer).
    return {
      outcome: 'contested',
      detail: JSON.stringify({
        competing: winners.map((w) => ({
          environmentId: w.environmentId,
          peerKeyFingerprint: w.peerKeyFingerprint
        }))
      })
    }
  }
  const winner = pickNewest(winners)
  const credentialFps = new Set(winners.map((w) => w.peerCredentialFp))
  const outcome = credentialFps.size === 1 ? 'duplicate_environment' : 'multi_grant'
  return {
    outcome,
    winner,
    detail: JSON.stringify({
      competingEnvironmentIds: winners
        .filter((w) => w.environmentId !== winner.environmentId)
        .map((w) => w.environmentId)
    })
  }
}

// R15.1's bind-time derivation, reading the mint-time fact device-registry-types.ts's
// `grantClass` already stores (S10-16 C1 review F1) rather than re-deriving from
// `pendingExpiresAt` presence — the same fallback `isMintedPendingDevice` uses for a row
// written before the field existed.
export function deriveGrantClassAtBind(device: {
  grantClass?: 'minted' | 'legacy_coalesced'
  pendingExpiresAt?: number
}): 'minted' | 'legacy_coalesced' {
  if (device.grantClass !== undefined) {
    return device.grantClass
  }
  return device.pendingExpiresAt !== undefined ? 'minted' : 'legacy_coalesced'
}
