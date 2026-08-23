import type { LaneWipeOutcome } from '../claude-accounts/principal-lane-lifecycle'
import { principalHasRemainingConnections } from '../claude-accounts/principal-lane-lifecycle'
import { getLaneWireService } from './lane-wire-service'

/**
 * Where S9c's two connection-driven wipes join the socket and grant registries (§2f).
 *
 * Both joins exist because the registries are keyed one hop away from the lane. The close path is
 * handed a grant's `deviceToken`; the lane is keyed by the PRINCIPAL that grant is bound to, and
 * the survivor question is asked across every grant of that principal — a person on a desktop and
 * a phone holds one lane through two grants. The revoke paths call `removeDevice` before
 * `forgetGrant`, so the principal has to be captured on the way in and the survivors counted on
 * the way out.
 */

export type PrincipalLaneConnectionJoin = {
  /** `deviceId → principalId`; already null for a grant whose registry row is gone. */
  principalOf(deviceId: string): string | null
  /** Grants still bound to this principal whose registry row survives. */
  boundDeviceIds(principalId: string): string[]
  /** Every device id with an authenticated socket right now, the closing one excluded. */
  connectedDeviceIds(): readonly string[]
  wipeLane(laneId: string): Promise<LaneWipeOutcome>
  removeLane(laneId: string): Promise<LaneWipeOutcome>
}

export type LaneCloseWipeResult = 'wiped' | 'not-wiped-other-connections' | 'not-wiped-no-lane'
export type LaneRevokeWipeResult = 'removed' | 'not-removed-grants-survive' | 'not-removed-no-lane'

/**
 * A connection closed: wipe the lane only if it was the PRINCIPAL's last authenticated socket.
 *
 * Keyed by `socket.device.deviceId`, never the `deviceToken` the close path is handed: the token
 * is the grant's, and a grant-keyed predicate wipes a person's live credential the moment either
 * of their devices drops off Wi-Fi. An idle/keepalive close arrives here like any other.
 */
export async function wipeLaneOnConnectionClose(
  join: PrincipalLaneConnectionJoin,
  closedDeviceId: string
): Promise<LaneCloseWipeResult> {
  const principalId = join.principalOf(closedDeviceId)
  if (!principalId) {
    return 'not-wiped-no-lane'
  }
  if (
    principalHasRemainingConnections({
      principalId,
      connectedDeviceIds: join.connectedDeviceIds(),
      principalOf: (deviceId) => join.principalOf(deviceId)
    })
  ) {
    return 'not-wiped-other-connections'
  }
  await join.wipeLane(principalId)
  return 'wiped'
}

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
  await join.removeLane(revokedPrincipalId)
  return 'removed'
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
    wipeLane: (laneId) => lifecycle.wipeOnLastConnectionClose(laneId),
    removeLane: (laneId) => lifecycle.removeLaneOnLastGrantRevoked(laneId)
  }
}
