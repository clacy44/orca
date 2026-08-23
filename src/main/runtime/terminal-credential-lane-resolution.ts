import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { PaneCredentialLane } from './pane-credential-lane-registry'

/**
 * What a `createTerminal` caller states about the lane its pane must run on (S9 §2a).
 *
 * Required, not optional: the compiler enumerates every spawner, so a new one cannot be added
 * without deciding. `inherit` names the pane to take it from and is resolved through the ownership
 * predicate, never trusted on its own.
 */
export type TerminalCredentialLaneOption =
  | PaneCredentialLane
  | { kind: 'inherit'; fromPtyId: string; pairedDeviceId?: string | null }

/** The paths that mean the host's own `~/.claude` say so explicitly. */
export const SHARED_CREDENTIAL_LANE: PaneCredentialLane = { kind: 'shared' }

export type PrincipalLookup = {
  principalOf(deviceId: string): string | null
  /** A federated link resolves through its bound grant's principal, never to a grant of its own. */
  linkPrincipalOf(homePeerFingerprint: string): string | null
}

/**
 * The funnel resolver, `deviceId → principalId → lane`.
 *
 * An anonymous socket and a grant bound to no principal both resolve `shared` — the latter is the
 * lane-less grant, with today's behaviour byte-for-byte.
 */
export function resolveCallerCredentialLane(
  pairedDeviceId: string | null | undefined,
  principals: PrincipalLookup | null | undefined
): PaneCredentialLane {
  if (!pairedDeviceId || !principals) {
    return SHARED_CREDENTIAL_LANE
  }
  const principalId = principals.principalOf(pairedDeviceId)
  return principalId ? { kind: 'principal', principalId } : SHARED_CREDENTIAL_LANE
}

/**
 * Fail-closed is a property of the field being required, not of the caller having an identity:
 * host-internal callers throw here too.
 */
export function assertCredentialLaneSupplied(
  lane: TerminalCredentialLaneOption | undefined
): TerminalCredentialLaneOption {
  if (
    !lane ||
    (lane.kind !== 'shared' && lane.kind !== 'principal' && lane.kind !== 'inherit') ||
    (lane.kind === 'principal' && !lane.principalId) ||
    (lane.kind === 'inherit' && !lane.fromPtyId)
  ) {
    throw new ClaudeLaneRefusal(
      'terminal.lane_unspecified',
      'Orca could not tell which Claude credential this terminal should use, so it was not created. Update the client or host and try again.'
    )
  }
  return lane
}
