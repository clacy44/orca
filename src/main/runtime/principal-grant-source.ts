// The row and option types the PrincipalRegistry reads; split out only to keep the registry file
// under the line ceiling. Re-exported from `principal-registry.ts`, so import sites are unchanged.

/** The registry rows the principal registry needs; the device registry supplies them. */
export type PrincipalGrantSource = {
  getDevice(deviceId: string): PrincipalGrantRow | null
  listDevices(): readonly PrincipalGrantRow[]
  /** False after a caught load throw — a destructive sweep must not read zero devices as zero grants. */
  readonly loadSucceeded: boolean
}

export type PrincipalGrantRow = {
  deviceId: string
  name: string
  token: string
  pairedAt: number
  lastSeenAt: number
  pendingExpiresAt?: number
}

/** One pairing grant as the host-only read surface sees it: label, lane binding and designation. */
export type LaneGrantSummary = {
  deviceId: string
  label: string
  /** True when the grant was minted from a per-person invite, so it is bindable (§2a rule (i)). */
  perPerson: boolean
  boundPrincipalId: string | null
  /** True when this grant is its principal's designated pusher (`delegatedGrantId`). */
  designated: boolean
  /** False for a per-person invite nobody has opened yet (M1) — `orca lane status`'s precondition. */
  redeemed: boolean
}

export type PrincipalRegistryOptions = {
  /** The runtime's shared auth token, refused by name as a federated link key (§2a rev 16). */
  runtimeAuthToken?: string | null
  now?: () => number
}
