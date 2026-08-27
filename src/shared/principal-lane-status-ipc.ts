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
 * A delegation lease as the AccountsPane renders it: the persisted lease PLUS, additively (Rule 1),
 * the names the desktop can resolve for it right now — the delegated account's email, the host
 * environment's name, and (when this desktop also provisions that principal) the person's display
 * name. Each is null when unresolvable, so the card falls back to the underlying id.
 */
export type PrincipalLaneStatusDelegationLease = ClaudeLaneDelegationLease & {
  accountLabel?: string | null
  hostLabel?: string | null
  personLabel?: string | null
}

/** What `principalLaneStatus:get` answers and `principalLaneStatus:changed` republishes. */
export type PrincipalLaneStatusSnapshot = {
  lanes: PrincipalLaneStatusRow[]
  /** The delegation leases THIS desktop persists — one row per account it delegated (§2e). */
  delegationLeases: PrincipalLaneStatusDelegationLease[]
  /** Additive (Rule 1): paired hosts this desktop can push a Claude account onto right now (B3). */
  delegableHosts: PrincipalLaneStatusDelegableHost[]
}

/** Release request: drop THIS desktop's delegation lease for one account (§2e recovery, Q-lease). */
export type PrincipalLaneStatusReleaseRequest = { accountId: string }
export type PrincipalLaneStatusReleaseResult = {
  released: boolean
  /**
   * Owner addendum: true when the released lease's `wasLocalActive` flag re-selected the account
   * locally after the release — the toast that tells the human their local sign-out is undone.
   */
  reselectedLocally: boolean
}

/** Rename request: set/clear the Q3 friendly name persisted on one lease. */
export type PrincipalLaneStatusRenameRequest = { accountId: string; friendlyName: string | null }
export type PrincipalLaneStatusRenameResult = { renamed: boolean }

/** Delegate request: push one named Claude account onto one paired host lane (B3). */
export type PrincipalLaneStatusDelegateRequest = { accountId: string; environmentId: string }
export type PrincipalLaneStatusDelegateResult = { delegated: boolean }

export const PRINCIPAL_LANE_STATUS_GET_CHANNEL = 'principalLaneStatus:get'
export const PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL = 'principalLaneStatus:changed'
export const PRINCIPAL_LANE_STATUS_RELEASE_CHANNEL = 'principalLaneStatus:release'
export const PRINCIPAL_LANE_STATUS_RENAME_CHANNEL = 'principalLaneStatus:rename'
export const PRINCIPAL_LANE_STATUS_DELEGATE_CHANNEL = 'principalLaneStatus:delegate'
