import type {
  PrincipalLaneStatusRefreshHostResult,
  PrincipalLaneStatusSnapshot
} from '../../shared/principal-lane-status-ipc'

// Host-only IPC (S9 §2e/§2h, §10(d), rev 32): the AccountsPane section's read of THIS desktop's
// own principal-lane residency and its remote-host discoverability rows. Sender-gated in main — a
// non-host frame gets the empty snapshot. A remote host's lane status arrives over the
// pre-existing `accounts.lane.status` RPC instead; this lane is the desktop's own lanes alone.
export type PrincipalLaneStatusApi = {
  /** Per-provisioned-lane residency plus every paired remote host's discoverability row. */
  get: () => Promise<PrincipalLaneStatusSnapshot>
  /** Republished when a provision/deprovision (or other residency change) fires on the host. */
  onChanged: (callback: (snapshot: PrincipalLaneStatusSnapshot) => void) => () => void
  /** Re-query one remote host's lane status right now (discoverability follow-up). */
  refreshHost: (environmentId: string) => Promise<PrincipalLaneStatusRefreshHostResult>
}
