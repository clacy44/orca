// S10-16 C5, R15/R16/R18.4: wires the pure `isRoutableBindingRow` predicate (link-binding-
// liveness.ts) to the real registry/environment-store sources, for the two callers that need a
// live routability read against an already-bound row — `orchestration.reply`'s foreign branch
// (R16) and the pump's per-attempt re-check (R18.4). Never used by the prover (C4): the prover
// PROVES new bindings; this module only re-checks one that already exists.
import type { OrcaRuntimeService } from '../orca-runtime'
import { hashCallerCredential } from '../principal-link-fingerprint-binding'
import { fingerprintOrchestrationPeer } from './environment-transport'
import {
  listEnvironments,
  RuntimeEnvironmentStoreError
} from '../../../shared/runtime-environment-store'
import { resolvePreferredEndpoint } from '../../../shared/runtime-environments'
import { resolveUserDataPath } from '../rpc/methods/orchestration-link-binding-pending'
import {
  isRoutableBindingRow,
  type IsRoutableOptions,
  type LinkBindingLivenessSources,
  type ResolvedEnvironmentEndpoint
} from './link-binding-liveness'
import type { PeerLinkBindingRow } from './link-binding-store'
import type { OrchestrationDb } from './db'

// R15.5: fingerprint sources are INJECTED — no token ever crosses into the liveness layer.
function buildLivenessSources(runtime: OrcaRuntimeService): LinkBindingLivenessSources {
  const db = runtime.getOrchestrationDb()
  return {
    isPeerLinkQuarantined: (linkDeviceId: string) => db.isPeerLinkQuarantined(linkDeviceId),
    registryLinkCredentialFingerprint: (linkDeviceId: string) =>
      runtime.linkBindingSelfView?.registryCredentialFingerprint(linkDeviceId) ?? null,
    resolveEnvironmentEndpoint: (environmentId: string): ResolvedEnvironmentEndpoint | null => {
      // R15's own floor: never throws. A corrupt store here reads as "no endpoint", and the
      // caller's own local_evidence_unavailable branch is what distinguishes that from a
      // genuinely gone environment (localEvidenceUnavailable, below).
      let environments: ReturnType<typeof listEnvironments>
      try {
        environments = listEnvironments(resolveUserDataPath())
      } catch {
        return null
      }
      const environment = environments.find((e) => e.id === environmentId)
      if (!environment) {
        return null
      }
      const endpoint = resolvePreferredEndpoint(environment)
      if (!endpoint) {
        return null
      }
      return {
        boundEndpointId: endpoint.id,
        boundPairingRevision: environment.pairingRevision ?? environment.createdAt,
        peerCredentialFp: hashCallerCredential(endpoint.deviceToken),
        peerKeyFingerprint: fingerprintOrchestrationPeer(endpoint.publicKeyB64)
      }
    },
    // No `accept_legacy` mint verb exists yet on this tree — a row-not-found result is the
    // correct, fail-closed answer (routingClassOf falls to 'legacy_unattested') until one does.
    liveLegacyAttestation: (
      linkDeviceId: string,
      environmentId: string,
      peerKeyFingerprint: string,
      now: number
    ): boolean => {
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
  }
}

function toLivenessRow(row: PeerLinkBindingRow): {
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
} {
  return {
    linkDeviceId: row.linkDeviceId,
    environmentId: row.environmentId,
    boundEndpointId: row.boundEndpointId,
    boundPairingRevision: row.boundPairingRevision,
    linkCredentialFp: row.linkCredentialFp,
    peerCredentialFp: row.peerCredentialFp,
    peerKeyFingerprint: row.peerKeyFingerprint,
    grantClass: row.grantClass,
    state: row.state,
    revokedAt: row.revokedAt
  }
}

// R15/R16/R18.4: returns the row only when `isRoutableBindingRow` holds for it — the ONE
// predicate, called through in both modes (never a second copy of the clause list, Ruling 23(g)).
export function getRoutableLinkBinding(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  linkDeviceId: string,
  options: IsRoutableOptions = {}
): PeerLinkBindingRow | null {
  const row = db.getPeerLinkBinding(linkDeviceId)
  if (!row) {
    return null
  }
  const sources = buildLivenessSources(runtime)
  return isRoutableBindingRow(toLivenessRow(row), sources, Date.now(), options) ? row : null
}

// R16/L4: this host's OWN evidence, not the peer's — a throw (never an empty store) on either
// local file. Never used to judge a PEER's absence (R12.1(1)'s separate rule).
export function localEvidenceUnavailable(runtime: OrcaRuntimeService): boolean {
  const selfView = runtime.linkBindingSelfView
  if (!selfView || !selfView.registryLoadSucceeded()) {
    return true
  }
  try {
    listEnvironments(resolveUserDataPath())
    return false
  } catch (error) {
    return error instanceof RuntimeEnvironmentStoreError
  }
}
