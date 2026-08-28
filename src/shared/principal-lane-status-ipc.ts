import type { RuntimeTerminalLaneState } from './runtime-types'

// The host-only lane-status seam (S9 §2e/§2h, §10(d), rev 32's re-basing). The AccountsPane
// section reads, for THIS desktop: the residency of each principal lane Orca has provisioned, and
// a discoverability row per paired remote environment. Both are host-side facts with no
// paired-client wire — the desktop's own lanes, not a remote's — so they reach the renderer over
// sender-gated IPC, exactly as the consent surface does.
//
// Rev 32 deletes the delegation lease and the push model with it (§10(g)): there is nothing left
// to release, rename or push onto a remote lane, so those three writes are gone from this seam.

/** One provisioned principal lane's status as the host observes it right now. */
export type PrincipalLaneStatusRow = {
  principalId: string
  displayName: string
  /** The grant this principal designated to sign this lane in, or null (§2d(i)). */
  delegatedGrantId: string | null
  /** `loaded` / `absent` / `reauth-required` — what a launch keys on (§2h). */
  laneState: RuntimeTerminalLaneState
}

/**
 * One remote Orca environment's lane-discoverability row (release-audit follow-up): exists for
 * EVERY paired environment, whether or not this desktop's grant on it is connected, designated,
 * or even lane-capable, so the AccountsPane section can always say why, instead of rendering
 * nothing when a host offers no lane to show.
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
      laneState: RuntimeTerminalLaneState
    }

/** What `principalLaneStatus:get` answers and `principalLaneStatus:changed` republishes. */
export type PrincipalLaneStatusSnapshot = {
  lanes: PrincipalLaneStatusRow[]
  /** Additive (Rule 1): every remote environment's row, ready or not (discoverability follow-up). */
  remoteHosts: PrincipalLaneStatusRemoteHostRow[]
}

/** Refresh request: re-query one remote host's lane status right now (discoverability follow-up). */
export type PrincipalLaneStatusRefreshHostRequest = { environmentId: string }
export type PrincipalLaneStatusRefreshHostResult = { refreshed: boolean }

export const PRINCIPAL_LANE_STATUS_GET_CHANNEL = 'principalLaneStatus:get'
export const PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL = 'principalLaneStatus:changed'
export const PRINCIPAL_LANE_STATUS_REFRESH_HOST_CHANNEL = 'principalLaneStatus:refreshHost'
