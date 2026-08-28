import type { LaneWipeOutcome } from '../claude-accounts/principal-lane-lifecycle'
import { getLaneWireService } from './lane-wire-service'

/**
 * Where S9c's revoke-driven wipe joins the socket and grant registries (§2f).
 *
 * The join exists because the registries are keyed one hop away from the lane. The revoke path
 * calls `removeDevice` before `forgetGrant`, so the principal has to be captured on the way in and
 * the survivors counted on the way out.
 *
 * S9-L1 (§modules C, the login model): the connection-CLOSE wipe this file used to join is
 * deleted. A socket closing is not a logout — the residency window is now login-until-logout, not
 * push-until-last-close — so `wipeLaneOnConnectionClose`/`LaneCloseWipeResult` and the join's
 * `wipeLane` member go with it. `removeLaneOnGrantRevoked` (a genuine revocation) stays.
 */

export type PrincipalLaneConnectionJoin = {
  /** `deviceId → principalId`; already null for a grant whose registry row is gone. */
  principalOf(deviceId: string): string | null
  /** Grants still bound to this principal whose registry row survives. */
  boundDeviceIds(principalId: string): string[]
  /** Every device id with an authenticated socket right now, the closing one excluded. */
  connectedDeviceIds(): readonly string[]
  removeLane(laneId: string): Promise<LaneWipeOutcome>
}

export type LaneRevokeWipeResult =
  | 'removed'
  | 'not-removed-grants-survive'
  | 'not-removed-no-lane'
  | 'not-removed-incomplete'

/**
 * A grant was revoked: remove the lane only when it was that principal's LAST grant.
 *
 * `principalId` is captured BEFORE `removeDevice` drops the registry row — after it, nothing can
 * tell a last grant from a first — and the survivor query runs after, so revoking one of two
 * devices of the same person removes nothing and their other device keeps launching into it.
 */
export async function removeLaneOnGrantRevoked(
  join: PrincipalLaneConnectionJoin,
  revokedPrincipalId: string | null
): Promise<LaneRevokeWipeResult> {
  if (!revokedPrincipalId) {
    return 'not-removed-no-lane'
  }
  if (join.boundDeviceIds(revokedPrincipalId).length > 0) {
    return 'not-removed-grants-survive'
  }
  const outcome = await join.removeLane(revokedPrincipalId)
  return outcome.completed && outcome.laneRemoved ? 'removed' : 'not-removed-incomplete'
}

/** The grant rows the two joins read; `PrincipalRegistry` satisfies it. */
export type PrincipalGrantBindings = {
  principalOf(deviceId: string): string | null
  boundDeviceIds(principalId: string): string[]
}

/**
 * Composes the join from the two things that outlive it: the attached principal registry and the
 * attached lane wire. Null whenever either is absent — a host with no lanes has nothing to wipe.
 */
export function createPrincipalLaneConnectionJoin(args: {
  bindings: PrincipalGrantBindings | null
  connectedDeviceIds(): readonly string[]
}): PrincipalLaneConnectionJoin | null {
  const lifecycle = getLaneWireService()?.coordinator.lifecycle
  if (!args.bindings || !lifecycle) {
    return null
  }
  const bindings = args.bindings
  return {
    principalOf: (deviceId) => bindings.principalOf(deviceId),
    boundDeviceIds: (principalId) => bindings.boundDeviceIds(principalId),
    connectedDeviceIds: args.connectedDeviceIds,
    removeLane: (laneId) => lifecycle.removeLaneOnLastGrantRevoked(laneId)
  }
}
