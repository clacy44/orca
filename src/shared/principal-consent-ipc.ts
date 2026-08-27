// The host-only consent seam's wire shapes (S9 §2a). These are the renderer's read-only view of the
// principal registry — principals, bindings, and the audit trail — delivered over Electron IPC to
// the host's own main frame ALONE (the bridge sender-gates every channel). The paired-grant half of
// a consent row (deviceId, name, lastSeenAt) already reaches the renderer through the access-grant
// list; nothing here re-delivers a credential or a grant token.
//
// Structurally aligned with the renderer's pure resolvers (principal-consent-surface-rows.ts,
// principal-consent-audit-rows.ts): the resolvers keep their own local types so they stay
// DOM-independent, and these wire types are the projection the bridge fills them from.

/** One person the registry knows, plus which of their grants is the designated pusher (§2e). */
export type ConsentPrincipalRow = {
  principalId: string
  displayName: string
  /** The device this principal designated as its lane's one pusher, or null (§2e). */
  delegatedGrantId: string | null
}

/** One binding: the grant belongs to this principal (§2a). Only surviving grants are listed. */
export type ConsentBindingRow = {
  deviceId: string
  principalId: string
}

/** The registry's audit action set (§2a), mirrored verbatim onto the wire. */
export type ConsentAuditAction =
  | 'create-principal'
  | 'bind'
  | 'unbind'
  | 'designate'
  | 'link-bind'
  | 'provision'
  | 'mint-invite'

/** One audit row, the registry row verbatim — the undo trail that keeps a mis-tick reversible. */
export type ConsentAuditRow = {
  at: number
  action: ConsentAuditAction
  principalId: string | null
  deviceId?: string
  direction?: 'bind' | 'unbind'
  homePeerFingerprint?: string
  designatedGrantId?: string | null
  /** Only a `provision` row on a §6-gated platform carries this (B2's operator override). */
  platformAcceptance?: 'unverified-win32' | 'unverified-darwin'
  /** Only a `mint-invite` row carries these two — never a token, never a pairing URL. */
  inviteScope?: 'mobile' | 'runtime'
  inviteExpiresAt?: number
}

/** What `principalConsent:snapshot` answers and `principalConsent:changed` republishes. */
export type PrincipalConsentSnapshot = {
  principals: ConsentPrincipalRow[]
  bindings: ConsentBindingRow[]
  audit: ConsentAuditRow[]
  /** Non-null only on a §6-gated platform (B2) — what the UI needs to offer the override checkbox. */
  provisioningPlatformGate: { platform: NodeJS.Platform; label: string; probe: string } | null
}

/**
 * Every write the host-only surface can make. The bridge refuses any non-host sender before it
 * constructs the `HostConsent` these all demand, so a remote code path can reach none of them.
 */
export type PrincipalConsentCreatePrincipalRequest = { displayName: string }
export type PrincipalConsentBindRequest = { deviceId: string; principalId: string }
export type PrincipalConsentUnbindRequest = { deviceId: string }
export type PrincipalConsentDesignateRequest = { principalId: string; deviceId: string }
export type PrincipalConsentPrincipalRequest = { principalId: string }
/** Provision alone gets its own request shape (Rule 1) — deprovision keeps the plain one above. */
export type PrincipalConsentProvisionRequest = {
  principalId: string
  acceptUnverifiedPlatform?: boolean
}

export type PrincipalConsentCreatePrincipalResult = {
  principalId: string
  displayName: string
}
export type PrincipalConsentBindResult = { bound: true }
export type PrincipalConsentUnbindResult = { unbound: boolean }
export type PrincipalConsentDesignateResult = { designatedGrantId: string }
export type PrincipalConsentProvisionResult = { provisioned: true; provenanceLabel: string }
export type PrincipalConsentDeprovisionResult = { deprovisioned: boolean }

export const PRINCIPAL_CONSENT_SNAPSHOT_CHANNEL = 'principalConsent:snapshot'
export const PRINCIPAL_CONSENT_CREATE_PRINCIPAL_CHANNEL = 'principalConsent:createPrincipal'
export const PRINCIPAL_CONSENT_BIND_CHANNEL = 'principalConsent:bind'
export const PRINCIPAL_CONSENT_UNBIND_CHANNEL = 'principalConsent:unbind'
export const PRINCIPAL_CONSENT_REBIND_CHANNEL = 'principalConsent:rebind'
export const PRINCIPAL_CONSENT_DESIGNATE_CHANNEL = 'principalConsent:designate'
export const PRINCIPAL_CONSENT_PROVISION_CHANNEL = 'principalConsent:provision'
export const PRINCIPAL_CONSENT_DEPROVISION_CHANNEL = 'principalConsent:deprovision'
export const PRINCIPAL_CONSENT_CHANGED_CHANNEL = 'principalConsent:changed'
