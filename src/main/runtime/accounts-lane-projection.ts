import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeCredentialIdentity } from '../../shared/claude-credential-identity-types'
import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import { getLaneWireService } from './lane-wire-service'
import type { LaneWireService } from './lane-wire-service'

/**
 * §2d's per-connection projection, and the caller-scope refusal beside it (rev 32's re-basing).
 *
 * `accounts.list` and BOTH `accounts.subscribe` emit points publish the shared snapshot verbatim
 * today, so grant B receives grant A's emails and usage. This adds ONE additive field: the lane
 * rows the caller may see. The caller's own lane is shown with its identity; another principal's
 * lane is an opaque `occupied` boolean and the owner's presence label. No account id, no email, no
 * usage, no sha, no lane path, and no `laneState`: §2d's enumeration is closed, and
 * `reauth-required` tells a peer the other person's account is in a broken-auth state, which is
 * strictly more than `occupied` carries. Rev 32 deletes the delegable list and the owner-set
 * `displayName` widening with the delegation directory that carried them (§10(g)); S9-L1's account
 * index restores an owner-set label under a different name once it lands.
 *
 * With zero lanes the projection returns the SAME OBJECT it was handed, so a pre-lane host is
 * byte-identical to today and not merely equal-looking.
 */

export type ClaudeLaneProjectionRow = {
  scope: 'self' | 'peer'
  /** SELF only. A peer gets `occupied` alone — `laneState` would leak `reauth-required` (§2d). */
  laneState?: RuntimeTerminalLaneState
  occupied: boolean
  ownerLabel: string | null
  /** Self only — §2d(i)'s designation signal, read by every bound desktop of this principal. */
  delegatedGrantId?: string | null
  callerIsDelegatedGrant?: boolean
  identity?: ClaudeCredentialIdentity | null
}

export type ClaudeLaneProjection = { claudeLanes: ClaudeLaneProjectionRow[] }

/**
 * §2d: an identified caller that HOLDS a lane may not move the host-wide selection.
 *
 * Not silently rescoped — a client that believes it moved the host must not believe it moved
 * something it did not. A caller with no provisioned lane keeps today's behaviour exactly.
 */
export function assertClaudeSelectionInScope(pairedDeviceId: string | null | undefined): void {
  const service = getLaneWireService()
  if (!service || !pairedDeviceId) {
    return
  }
  const caller = service.authority.resolveCaller(pairedDeviceId)
  if (!caller || !hasProvisionedLane(service, caller.principalId)) {
    return
  }
  throw new ClaudeLaneRefusal(
    'accounts.selection_out_of_scope',
    'This device has its own Claude credential lane on this host, so it cannot change which account everyone else uses. Switch the account in your own lane instead.'
  )
}

export function projectAccountsSnapshot<T extends object>(
  snapshot: T,
  pairedDeviceId: string | null | undefined
): T | (T & ClaudeLaneProjection) {
  const service = getLaneWireService()
  if (!service) {
    return snapshot
  }
  const rows = projectLaneRows(service, pairedDeviceId)
  return rows.length === 0 ? snapshot : { ...snapshot, claudeLanes: rows }
}

/**
 * The self row comes from `resolveCaller` + `resolveLaneDir` — the SAME source the caller-scope
 * refusal reads — and `listPrincipals` enumerates peers only. Deriving the self row from the
 * enumeration instead let an absent or incomplete `listPrincipals` drop the caller's own row while
 * `assertClaudeSelectionInScope` still refused them, which is §3's forbidden degradation: the
 * phone would read `holdsLane: false`, send `accounts.selectClaude`, and be refused out of scope
 * with no delegated route offered.
 */
function projectLaneRows(
  service: LaneWireService,
  pairedDeviceId: string | null | undefined
): ClaudeLaneProjectionRow[] {
  const caller = pairedDeviceId ? service.authority.resolveCaller(pairedDeviceId) : null
  const rows: ClaudeLaneProjectionRow[] = []
  if (caller && hasProvisionedLane(service, caller.principalId)) {
    const status = service.authority.statusOf(caller)
    rows.push({
      scope: 'self',
      laneState: status.laneState,
      occupied: status.laneState !== 'absent',
      ownerLabel: service.labelOf(caller.principalId),
      delegatedGrantId: status.delegatedGrantId,
      callerIsDelegatedGrant: status.callerIsDelegatedGrant,
      identity: status.heldIdentity
    })
  }
  for (const lane of service.listLanes()) {
    if (
      lane.principalId === caller?.principalId ||
      !hasProvisionedLane(service, lane.principalId)
    ) {
      continue
    }
    const laneState = service.coordinator.store.getLaneState(lane.principalId)
    rows.push({
      scope: 'peer',
      occupied: laneState !== 'absent',
      ownerLabel: lane.label
    })
  }
  return rows
}

function hasProvisionedLane(service: LaneWireService, principalId: string): boolean {
  return service.coordinator.store.resolveLaneDir(principalId) !== null
}
