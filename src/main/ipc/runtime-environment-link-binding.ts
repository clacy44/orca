// S10-16 R7.3 steps 5/7 (design v6): the responder's own env-store side of the proof protocol —
// the store-readability precondition (R12.1(1), split P6), the selector scan, and the proof/
// confirm MAC computation. Deliberately NEVER returns a `deviceToken` to its caller: every
// function that needs a saved environment's credential computes the MAC internally and returns
// only the result, matching device-registry-link-credential.ts's own discipline.
import { statSync } from 'node:fs'
import { listEnvironments, getEnvironmentStorePath } from '../../shared/runtime-environment-store'
import {
  resolvePreferredEndpoint,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
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
  | {
      status: 'ok'
      // Review F9: the scan's own already-loaded list, reused by the caller for every matched
      // slot's proof MAC instead of each one re-reading and re-zod-parsing the whole store.
      environments: readonly KnownRuntimeEnvironment[]
      matchesBySlot: ReadonlyMap<number, readonly LinkBindingCandidate[]>
    }

// Review F11: was a reimplementation of shared/runtime-environments.ts's preferred-endpoint
// resolution (the schema's `endpoints.min(1)` makes the two's null-vs-throw difference moot).
function resolveBoundEndpoint(
  environment: KnownRuntimeEnvironment
): { id: string; deviceToken: string; publicKeyB64: string } | null {
  return resolvePreferredEndpoint(environment)
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
    // Review F8: `readEnvironmentStore` early-returns "empty" for ANY `existsSync` failure,
    // including EACCES on the file or a parent dir — the exact misreport P6 exists to prevent,
    // masking an operator-visible fault as a truthful "no environments" state. `statSync`
    // (unlike `existsSync`) propagates that failure rather than swallowing it to `false`.
    try {
      statSync(getEnvironmentStorePath(userDataPath))
      return { status: 'empty' }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { status: 'empty' }
      }
      return { status: 'unreadable' }
    }
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
  return { status: 'ok', environments, matchesBySlot }
}

// Review F9: a probe/confirm call must read and zod-parse the store AT MOST ONCE, not once per
// slot — a peer-chosen selector/confirm count up to 8 previously multiplied the read. Callers
// load once (via this function, or reuse `scanEnvironmentsForSelectors`'s own `environments`)
// and pass the same list into every `computeCandidateMacFromEnvironments` call for that request.
export function loadEnvironmentsForLinkBinding(
  userDataPath: string
): readonly KnownRuntimeEnvironment[] | null {
  try {
    return listEnvironments(userDataPath)
  } catch {
    return null
  }
}

/**
 * Computes a proof/confirm MAC over a specific, already-matched environment's bound-endpoint
 * device token, against an ALREADY-LOADED environment list (F9 — never re-reads the store).
 * Returns null if the environment has vanished since the scan (a benign race — the caller
 * refuses the slot rather than throwing). NEVER returns the token itself.
 */
export function computeCandidateMacFromEnvironments(
  environments: readonly KnownRuntimeEnvironment[],
  environmentId: string,
  label: string,
  fields: readonly string[]
): string | null {
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
