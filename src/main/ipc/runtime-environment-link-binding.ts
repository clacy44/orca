// S10-16 R7.3 steps 5/7 (design v6): the responder's own env-store side of the proof protocol —
// the store-readability precondition (R12.1(1), split P6), the selector scan, and the proof/
// confirm MAC computation. Deliberately NEVER returns a `deviceToken` to its caller: every
// function that needs a saved environment's credential computes the MAC internally and returns
// only the result, matching device-registry-link-credential.ts's own discipline.
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { hashCallerCredential } from '../runtime/principal-link-fingerprint-binding'
import { fingerprintOrchestrationPeer } from '../runtime/orchestration/environment-transport'
import {
  linkBindingMac,
  linkBindingMacEquals,
  SELECTOR_LABEL
} from '../runtime/orchestration/link-binding-proof'

export type LinkBindingCandidate = {
  environmentId: string
  boundEndpointId: string
  boundPairingRevision: number
  peerKeyFingerprint: string
  peerCredentialFp: string
}

export type SelectorScanResult =
  | { status: 'unreadable' }
  | { status: 'empty' }
  | { status: 'ok'; matchesBySlot: ReadonlyMap<number, readonly LinkBindingCandidate[]> }

function resolveBoundEndpoint(
  environment: KnownRuntimeEnvironment
): { id: string; deviceToken: string; publicKeyB64: string } | null {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  return endpoint
    ? { id: endpoint.id, deviceToken: endpoint.deviceToken, publicKeyB64: endpoint.publicKeyB64 }
    : null
}

function toCandidate(
  environment: KnownRuntimeEnvironment,
  endpoint: { id: string; deviceToken: string; publicKeyB64: string }
): LinkBindingCandidate {
  return {
    environmentId: environment.id,
    boundEndpointId: endpoint.id,
    boundPairingRevision: environment.pairingRevision ?? environment.createdAt,
    peerKeyFingerprint: fingerprintOrchestrationPeer(endpoint.publicKeyB64),
    peerCredentialFp: hashCallerCredential(endpoint.deviceToken)
  }
}

/**
 * R7.3 step 5: `listEnvironments` is called inside a try. Throwing ⇒ `unreadable` (a real fault
 * on this host). Zero entries ⇒ `empty` (a truthful, unexceptional state — first launch, a
 * serve-only host, an asymmetric topology). R7.3 step 7: for each real (non-padding) slot, for
 * each saved environment, compute the selector MAC over that environment's OWN bound-endpoint
 * device token and compare with `linkBindingMacEquals` against the caller-supplied selector for
 * that slot. `buildSelectorFields(slotIndex)` supplies the transcript fields (`probeId`, `nonceH`,
 * `String(slotIndex)`, `String(epoch)`, `observedChannelFp`, `dstKeyFp`) the caller has already
 * assembled from the request plus its own self-view.
 */
export function scanEnvironmentsForSelectors(
  userDataPath: string,
  selectors: readonly string[],
  buildSelectorFields: (slotIndex: number) => readonly string[]
): SelectorScanResult {
  let environments: KnownRuntimeEnvironment[]
  try {
    environments = listEnvironments(userDataPath)
  } catch {
    return { status: 'unreadable' }
  }
  if (environments.length === 0) {
    return { status: 'empty' }
  }
  const matchesBySlot = new Map<number, LinkBindingCandidate[]>()
  for (let slotIndex = 0; slotIndex < selectors.length; slotIndex += 1) {
    const selector = selectors[slotIndex]
    if (selector === undefined) {
      continue
    }
    const fields = buildSelectorFields(slotIndex)
    const matches: LinkBindingCandidate[] = []
    for (const environment of environments) {
      const endpoint = resolveBoundEndpoint(environment)
      if (!endpoint) {
        continue
      }
      const candidateMac = linkBindingMac(endpoint.deviceToken, SELECTOR_LABEL, fields)
      if (linkBindingMacEquals(candidateMac, selector)) {
        matches.push(toCandidate(environment, endpoint))
      }
    }
    if (matches.length > 0) {
      matchesBySlot.set(slotIndex, matches)
    }
  }
  return { status: 'ok', matchesBySlot }
}

/**
 * Computes a proof/confirm MAC over a specific, already-matched environment's bound-endpoint
 * device token. Returns null if the environment has vanished since the scan (a benign race —
 * the caller refuses the slot rather than throwing). NEVER returns the token itself.
 */
export function computeCandidateMac(
  userDataPath: string,
  environmentId: string,
  label: string,
  fields: readonly string[]
): string | null {
  let environments: KnownRuntimeEnvironment[]
  try {
    environments = listEnvironments(userDataPath)
  } catch {
    return null
  }
  const environment = environments.find((entry) => entry.id === environmentId)
  if (!environment) {
    return null
  }
  const endpoint = resolveBoundEndpoint(environment)
  if (!endpoint) {
    return null
  }
  return linkBindingMac(endpoint.deviceToken, label, fields)
}
