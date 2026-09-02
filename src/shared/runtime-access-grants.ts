export type RuntimeAccessGrant = {
  deviceId: string
  name: string
  createdAt: number
  lastSeenAt: number | null
  // S10-16 C1 review round 2 D3: 'minted' for a per-person invite, 'legacy_coalesced' for a row the
  // R1.4 sweep stamped; absent on a row minted before this field existed, which maps to
  // 'legacy_coalesced' (same fallback isMintedPendingDevice uses: undefined grantClass means "not a
  // provably-minted row"). S10-19 will add `accessProfile` and `enforcedByRuntime` to this same
  // projection.
  grantClass: 'minted' | 'legacy_coalesced'
  // pendingExpiresAt if the row carries one, else null — lets a dead (expired, never-consumed)
  // legacy_coalesced grant be told apart from a live one in the list, instead of rendering identically.
  expiresAt: number | null
}
