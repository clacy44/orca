import type { ClaudeLaneDelegationLease } from './claude-lane-lease'
import type { RuntimeTerminalLaneState } from './runtime-types'

// The host-only lane-status seam (S9 §2e/§2h, §10(d)). The AccountsPane section reads, for THIS
// desktop: the residency of each principal lane Orca has provisioned, and the delegation leases
// this machine holds (the rows that suppress its own rotation of a delegated account). Both are
// host-side facts with no paired-client wire — the desktop's own lanes, not a remote's — so they
// reach the renderer over sender-gated IPC, exactly as the consent surface does.

/** One provisioned principal lane's status as the host observes it right now. */
export type PrincipalLaneStatusRow = {
  principalId: string
  displayName: string
  /** The grant this principal designated as its one pusher, or null (§2e). */
  delegatedGrantId: string | null
  /** `loaded` / `absent` / `reauth-required` — what a launch keys on (§2h). */
  laneState: RuntimeTerminalLaneState
}

/** What `principalLaneStatus:get` answers and `principalLaneStatus:changed` republishes. */
export type PrincipalLaneStatusSnapshot = {
  lanes: PrincipalLaneStatusRow[]
  /** The delegation leases THIS desktop persists — one row per account it delegated (§2e). */
  delegationLeases: ClaudeLaneDelegationLease[]
}

export const PRINCIPAL_LANE_STATUS_GET_CHANNEL = 'principalLaneStatus:get'
export const PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL = 'principalLaneStatus:changed'
