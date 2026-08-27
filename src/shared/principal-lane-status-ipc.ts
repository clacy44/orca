import type { ClaudeLaneDelegationLease } from './claude-lane-lease'
import type { RuntimeTerminalLaneState } from './runtime-types'

/** One reachable, connected host lane this desktop's grant is designated to push (B3). */
export type PrincipalLaneStatusDelegableHost = {
  environmentId: string
  label: string
  laneId: string
  laneState: RuntimeTerminalLaneState
}

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

/**
 * One remote Orca environment's lane-discoverability row (release-audit follow-up): exists for
 * EVERY paired environment, whether or not this desktop's grant on it is connected, designated,
 * or even lane-capable, so the AccountsPane section can always say why, instead of rendering
 * nothing when a host offers no delegate target.
 */
export type PrincipalLaneStatusRemoteHostRow =
  | { environmentId: string; label: string; state: 'checking' }
  | { environmentId: string; label: string; state: 'unreachable' }
  | { environmentId: string; label: string; state: 'unsupported' }
  | { environmentId: string; label: string; state: 'not-designated' }
  | {
      environmentId: string
      label: string
      state: 'ready'
      laneId: string
      laneState: RuntimeTerminalLaneState
    }

/** What `principalLaneStatus:get` answers and `principalLaneStatus:changed` republishes. */
export type PrincipalLaneStatusSnapshot = {
  lanes: PrincipalLaneStatusRow[]
  /** The delegation leases THIS desktop persists — one row per account it delegated (§2e). */
  delegationLeases: ClaudeLaneDelegationLease[]
  /** Additive (Rule 1): paired hosts this desktop can push a Claude account onto right now (B3). */
  delegableHosts: PrincipalLaneStatusDelegableHost[]
  /** Additive (Rule 1): every remote environment's row, ready or not (discoverability follow-up). */
  remoteHosts: PrincipalLaneStatusRemoteHostRow[]
}

/** Release request: drop THIS desktop's delegation lease for one account (§2e recovery, Q-lease). */
export type PrincipalLaneStatusReleaseRequest = { accountId: string }
export type PrincipalLaneStatusReleaseResult = { released: boolean }

/** Rename request: set/clear the Q3 friendly name persisted on one lease. */
export type PrincipalLaneStatusRenameRequest = { accountId: string; friendlyName: string | null }
export type PrincipalLaneStatusRenameResult = { renamed: boolean }

/** Delegate request: push one named Claude account onto one paired host lane (B3). */
export type PrincipalLaneStatusDelegateRequest = { accountId: string; environmentId: string }
export type PrincipalLaneStatusDelegateResult = { delegated: boolean }

/** Refresh request: re-query one remote host's lane status right now (discoverability follow-up). */
export type PrincipalLaneStatusRefreshHostRequest = { environmentId: string }
export type PrincipalLaneStatusRefreshHostResult = { refreshed: boolean }

export const PRINCIPAL_LANE_STATUS_GET_CHANNEL = 'principalLaneStatus:get'
export const PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL = 'principalLaneStatus:changed'
export const PRINCIPAL_LANE_STATUS_RELEASE_CHANNEL = 'principalLaneStatus:release'
export const PRINCIPAL_LANE_STATUS_RENAME_CHANNEL = 'principalLaneStatus:rename'
export const PRINCIPAL_LANE_STATUS_DELEGATE_CHANNEL = 'principalLaneStatus:delegate'
export const PRINCIPAL_LANE_STATUS_REFRESH_HOST_CHANNEL = 'principalLaneStatus:refreshHost'
