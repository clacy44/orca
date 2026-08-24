import { createHash } from 'node:crypto'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'

export type LinkBindableGrant = {
  deviceId: string
  token: string
}

export type LinkFingerprintContext = {
  /** The runtime's own shared `authToken` — every local-socket caller hashes to it. */
  runtimeAuthToken: string | null
  grants: readonly LinkBindableGrant[]
}

// Why: `authenticatedCallerFingerprint` falls back to this literal when a request carries neither
// an auth token nor a device token (`rpc/orchestration-mutation-executor.ts:132`).
export const AUTHENTICATED_TRANSPORT_FALLBACK = 'authenticated_transport'

export function hashCallerCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('hex')
}

/**
 * Resolves the ONE paired grant a federated link's home-peer fingerprint names, or refuses.
 *
 * The fingerprint is `sha256(authToken || deviceToken || 'authenticated_transport')`, which is two
 * different things: for a paired peer it identifies one grant, and for every local-socket caller —
 * the `orca` CLI, the renderer, either developer on the shared box — it collapses onto one shared
 * value that names no link at all. Binding that value would let a local caller create in another
 * principal's lane, so both non-link values are refused BY NAME, and a bindable fingerprint must
 * match exactly one registry row's token (§2a, rev 16).
 */
export function resolveBindableLinkGrant(
  homePeerFingerprint: string,
  context: LinkFingerprintContext
): LinkBindableGrant {
  const unbindable = (reason: string): ClaudeLaneRefusal =>
    new ClaudeLaneRefusal(
      'accounts.lane.link_fingerprint_unbindable',
      `Orca cannot bind this federated link to a person: ${reason}. Bind the link from the home peer's own paired grant, or re-pair it and tick again.`
    )
  if (
    context.runtimeAuthToken &&
    homePeerFingerprint === hashCallerCredential(context.runtimeAuthToken)
  ) {
    throw unbindable("the caller is this host's local Orca connection, which is not a link")
  }
  if (homePeerFingerprint === hashCallerCredential(AUTHENTICATED_TRANSPORT_FALLBACK)) {
    throw unbindable('the caller presented no per-link credential')
  }
  const matches = context.grants.filter(
    (grant) => hashCallerCredential(grant.token) === homePeerFingerprint
  )
  if (matches.length !== 1 || !matches[0]) {
    throw unbindable(
      matches.length === 0
        ? 'no paired grant on this host matches it'
        : 'more than one paired grant matches it'
    )
  }
  return matches[0]
}

/**
 * Whether a stored link binding still names the grant it was ticked for.
 *
 * A re-pair rotates the row's `token` (`device-registry.ts:94`), so the fingerprint stops matching
 * and the link falls back to the conservative refusal until the human re-ticks — stated as a cost,
 * not an elegance (§2a, rev 16 clause (c)).
 */
export function isLinkBindingStillValid(
  homePeerFingerprint: string,
  grant: LinkBindableGrant | null
): boolean {
  return Boolean(grant && hashCallerCredential(grant.token) === homePeerFingerprint)
}
