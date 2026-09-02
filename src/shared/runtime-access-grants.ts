export type RuntimeAccessGrant = {
  deviceId: string
  name: string
  createdAt: number
  lastSeenAt: number | null
  // S10-19: the profile recorded on the grant itself; undefined on a pre-slice grant.
  profile?: 'full' | 'peer'
  // S10-19: the resolved profile this runtime actually enforces for the grant (effectiveAccessProfile).
  effective?: 'full' | 'peer'
  // S10-19: whether THIS runtime is the one enforcing the profile (vs. a relay/legacy hop that
  // cannot see it) — surfaced so an operator's grant list never implies an enforcement guarantee
  // this process cannot back up.
  enforcedByThisRuntime?: boolean
}
