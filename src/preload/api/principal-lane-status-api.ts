import type {
  PrincipalLaneStatusReleaseResult,
  PrincipalLaneStatusRenameResult,
  PrincipalLaneStatusSnapshot
} from '../../shared/principal-lane-status-ipc'

// Host-only IPC (S9 §2e/§2h, §10(d)): the AccountsPane section's read of THIS desktop's own
// principal-lane residency and its delegation leases. Sender-gated in main — a non-host frame gets
// the empty snapshot. A remote host's lane status arrives over the pre-existing `accounts.lane.status`
// RPC instead; this lane is the desktop's own lanes alone.
export type PrincipalLaneStatusApi = {
  /** Per-provisioned-lane residency plus this desktop's delegation leases. Read once on mount. */
  get: () => Promise<PrincipalLaneStatusSnapshot>
  /** Republished when a provision/deprovision (or other residency change) fires on the host. */
  onChanged: (callback: (snapshot: PrincipalLaneStatusSnapshot) => void) => () => void
  /** Drop THIS desktop's delegation lease for the account (§2e recovery). Republishes the lease view. */
  releaseLease: (accountId: string) => Promise<PrincipalLaneStatusReleaseResult>
  /** Set/clear the Q3 friendly name persisted on the lease. Republishes the lease view. */
  renameLease: (
    accountId: string,
    friendlyName: string | null
  ) => Promise<PrincipalLaneStatusRenameResult>
}
