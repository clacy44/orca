import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeCredentialIdentity } from '../../shared/claude-credential-identity-types'
import type { ClaudeLaneDelegableAccount } from '../../shared/claude-lane-delegation'
import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import { getLaneWireService } from './lane-wire-service'
import type { LaneWireService } from './lane-wire-service'

/**
 * §2d's per-connection projection, and the caller-scope refusal beside it.
 *
 * `accounts.list` and BOTH `accounts.subscribe` emit points publish the shared snapshot verbatim
 * today, so grant B receives grant A's emails and usage. This adds ONE additive field: the lane
 * rows the caller may see. The caller's own lane is shown with its identity and its delegable
 * list; another principal's lane is an opaque `occupied` boolean, the owner's presence label and
 * — because Q3 is about the label the other developer sees — the account's `displayName` when its
 * owner set one. No account id, no email, no usage, no sha, no lane path.
 *
 * With zero lanes the projection returns the SAME OBJECT it was handed, so a pre-lane host is
 * byte-identical to today and not merely equal-looking.
 */

export type ClaudeLaneProjectionRow = {
  scope: 'self' | 'peer'
  laneState: RuntimeTerminalLaneState
  occupied: boolean
  ownerLabel: string | null
  /** The one deliberate peer-visible widening (§2b/§2k): an owner-authored name, never an email. */
  displayName: string | null
  /** Self only — §2e's suppression signal, read by every bound desktop of this principal. */
  delegatedGrantId?: string | null
  callerIsDelegatedGrant?: boolean
  identity?: ClaudeCredentialIdentity | null
  delegable?: ClaudeLaneDelegableAccount[]
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

function projectLaneRows(
  service: LaneWireService,
  pairedDeviceId: string | null | undefined
): ClaudeLaneProjectionRow[] {
  const caller = pairedDeviceId ? service.authority.resolveCaller(pairedDeviceId) : null
  const rows: ClaudeLaneProjectionRow[] = []
  for (const lane of service.listLanes()) {
    if (!hasProvisionedLane(service, lane.principalId)) {
      continue
    }
    const laneState = service.coordinator.store.getLaneState(lane.principalId)
    const delegationRow = service.delegation.getRow(lane.principalId)
    if (caller && caller.principalId === lane.principalId) {
      const status = service.authority.statusOf(caller)
      rows.push({
        scope: 'self',
        laneState,
        occupied: laneState !== 'absent',
        ownerLabel: lane.label,
        displayName: status.heldDisplayName,
        delegatedGrantId: status.delegatedGrantId,
        callerIsDelegatedGrant: status.callerIsDelegatedGrant,
        identity: status.heldIdentity,
        delegable: status.delegable
      })
      continue
    }
    rows.push({
      scope: 'peer',
      laneState,
      occupied: laneState !== 'absent',
      ownerLabel: lane.label,
      displayName: delegationRow.heldDisplayName
    })
  }
  return rows
}

function hasProvisionedLane(service: LaneWireService, principalId: string): boolean {
  return service.coordinator.store.resolveLaneDir(principalId) !== null
}
