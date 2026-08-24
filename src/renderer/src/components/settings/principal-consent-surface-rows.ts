// Why a pure resolver beside the (host-only) consent surface: which paired-device row can be bound
// to a person, which person a row already belongs to, and which of a principal's grants is the one
// that pushes are the rules of S9 §2a — and they must be assertable without a DOM. The React surface
// renders these rows and calls the LOCAL consent channel; it never decides eligibility itself.
//
// These types are the renderer's read-only view of the principal registry, delivered over the
// host-only IPC seam. They are deliberately NOT `RuntimeAccessGrant` extended in place: the consent
// facts are a different projection, joined here rather than on the grant row.

/** A paired device/grant as the access-grant list already knows it (S9 §2a legibility, rule (ii)). */
export type ConsentSurfaceGrant = {
  deviceId: string
  name: string
  /** `0`/`null` is the never-connected discriminator `isMintedPendingDevice` keys on (§2a rule (ii)). */
  lastSeenAt: number | null
}

export type ConsentSurfacePrincipal = {
  principalId: string
  displayName: string
  /** The device the principal designated as its pusher, or null when none is designated (§2e). */
  delegatedGrantId: string | null
}

/** One binding row: which principal a grant belongs to (§2a). */
export type ConsentSurfaceBinding = {
  deviceId: string
  principalId: string
}

export type ConsentDeviceRow = {
  deviceId: string
  name: string
  /** Rule (ii): a legibility fact the human reads before ticking, not a gate. */
  everConnected: boolean
  /** The person this grant belongs to, joined from the binding; null offers a bind (rule (i)). */
  boundPrincipal: { principalId: string; displayName: string } | null
  /** Rule (iii)/§2e: this device is its principal's one pusher. Ticked in the surface. */
  isDesignatedPusher: boolean
  /** An unbound row can be bound; the registry still refuses a coalesced (never-minted) row. */
  canBind: boolean
  /** A bound row can be designated its principal's pusher; unbound rows cannot. */
  canDesignate: boolean
}

/**
 * Join the paired grants against the principal registry into one row per device (S9 §2a).
 *
 * The binding is the authority, never the grant's `name` (a free-form, non-unique string, §2a):
 * a row's owner is resolved through the binding to a principal, and the designation is read from
 * that principal's `delegatedGrantId`, so a device only shows as the pusher for the principal it is
 * actually bound to.
 */
export function resolveConsentDeviceRows(input: {
  grants: readonly ConsentSurfaceGrant[]
  principals: readonly ConsentSurfacePrincipal[]
  bindings: readonly ConsentSurfaceBinding[]
}): ConsentDeviceRow[] {
  const principalById = new Map(
    input.principals.map((principal) => [principal.principalId, principal])
  )
  const principalIdByDevice = new Map(
    input.bindings.map((binding) => [binding.deviceId, binding.principalId])
  )
  return input.grants.map((grant) => {
    const principalId = principalIdByDevice.get(grant.deviceId) ?? null
    const principal = principalId ? (principalById.get(principalId) ?? null) : null
    const boundPrincipal = principal
      ? { principalId: principal.principalId, displayName: principal.displayName }
      : null
    return {
      deviceId: grant.deviceId,
      name: grant.name,
      everConnected: grant.lastSeenAt !== null && grant.lastSeenAt !== 0,
      boundPrincipal,
      // Why join back through the principal and not just `delegatedGrantId === deviceId`: a stale
      // designation on the WRONG principal must not light this row up as its pusher.
      isDesignatedPusher: principal?.delegatedGrantId === grant.deviceId,
      canBind: boundPrincipal === null,
      canDesignate: boundPrincipal !== null
    }
  })
}
