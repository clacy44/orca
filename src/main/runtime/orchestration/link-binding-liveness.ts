// S10-16 C4, R15 (design v6): the liveness-and-routing predicate, recomputed locally on every
// read — no socket, no cache, no staleness anywhere in it. R15.5: fingerprint sources are
// INJECTED functions, so no token ever crosses into this layer.
//
// Review F13 residual (s10-16-review-C2.md): `getContainment`/`listContainment` do not filter
// expiry/lifted themselves — this module's `sources.liveLegacyAttestation` is where that filter
// MUST be applied (its own doc comment restates the requirement at the call site).

export type LinkBindingLivenessRow = {
  linkDeviceId: string
  environmentId: string
  boundEndpointId: string
  boundPairingRevision: number
  linkCredentialFp: string
  peerCredentialFp: string
  peerKeyFingerprint: string
  grantClass: 'minted' | 'legacy_coalesced'
  state: 'confirmed' | 'contested' | 'revoked'
  revokedAt: number | null
}

export type ResolvedEnvironmentEndpoint = {
  boundEndpointId: string
  boundPairingRevision: number
  peerCredentialFp: string
  peerKeyFingerprint: string
}

export type LinkBindingLivenessSources = {
  isPeerLinkQuarantined(linkDeviceId: string): boolean
  // R15.3: reads `orca-devices.json`. Null means the device is gone, unreachable, or not
  // `scope==='runtime'` — every one of those is a liveness failure, never a throw.
  registryLinkCredentialFingerprint(linkDeviceId: string): string | null
  // R15's outbound half: reads `orca-environments.json` + resolves the bound endpoint. Null means
  // the environment is gone or has no resolvable endpoint — never a throw (R15.5's own test:
  // "removing the environment kills it with no throw").
  resolveEnvironmentEndpoint(environmentId: string): ResolvedEnvironmentEndpoint | null
  // R15.1/R15.2: a LIVE, UNEXPIRED `accept_legacy` containment row naming this exact
  // environment+key. F13 residual: the caller filters `lifted_at IS NULL AND (expires_at IS NULL
  // OR expires_at > now)` itself — `getContainment` does not.
  liveLegacyAttestation(
    linkDeviceId: string,
    environmentId: string,
    peerKeyFingerprint: string,
    now: number
  ): boolean
}

export type LinkBindingRoutingClass = 'minted' | 'legacy_attested' | 'legacy_unattested'

// R15.1: the Ruling 14(c) routing clause. `row.grantClass` is the mint-time fact stored on the
// binding row at bind time (link-binding-classify.ts's `deriveGrantClassAtBind`) — never
// re-derived from the device registry at read time.
export function routingClassOf(
  row: Pick<
    LinkBindingLivenessRow,
    'grantClass' | 'linkDeviceId' | 'environmentId' | 'peerKeyFingerprint'
  >,
  sources: Pick<LinkBindingLivenessSources, 'liveLegacyAttestation'>,
  now: number
): LinkBindingRoutingClass {
  if (row.grantClass === 'minted') {
    return 'minted'
  }
  return sources.liveLegacyAttestation(
    row.linkDeviceId,
    row.environmentId,
    row.peerKeyFingerprint,
    now
  )
    ? 'legacy_attested'
    : 'legacy_unattested'
}

export type IsRoutableOptions = {
  // R15's `sqliteOnly` mode: drops only the two clauses that read JSON files (the device
  // registry and the environment store) — everything else (state/revoked/quarantine/routingClass)
  // is SQLite-only already and stays in force.
  sqliteOnly?: boolean
}

// R15: `getRoutableLinkBinding` returns a row only when ALL hold. This function is the
// pure predicate half — the caller resolves `row` via its own lookup and passes it in.
export function isRoutableBindingRow(
  row: LinkBindingLivenessRow,
  sources: LinkBindingLivenessSources,
  now: number,
  options: IsRoutableOptions = {}
): boolean {
  if (row.state !== 'confirmed' || row.revokedAt !== null) {
    return false
  }
  if (sources.isPeerLinkQuarantined(row.linkDeviceId)) {
    return false
  }
  if (!options.sqliteOnly) {
    const linkFp = sources.registryLinkCredentialFingerprint(row.linkDeviceId)
    if (linkFp === null || linkFp !== row.linkCredentialFp) {
      return false
    }
    const endpoint = sources.resolveEnvironmentEndpoint(row.environmentId)
    if (!endpoint) {
      return false
    }
    if (
      endpoint.boundEndpointId !== row.boundEndpointId ||
      endpoint.boundPairingRevision !== row.boundPairingRevision ||
      endpoint.peerCredentialFp !== row.peerCredentialFp ||
      endpoint.peerKeyFingerprint !== row.peerKeyFingerprint
    ) {
      return false
    }
  }
  return routingClassOf(row, sources, now) !== 'legacy_unattested'
}
