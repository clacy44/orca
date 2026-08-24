// Why a pure resolver: the audit list is the ONLY thing that makes a mis-tick visible and a bind
// reversible (S9 §2a rule (iii)), so what each row SAYS — whose device, which person, what happened
// — is a join with rules, and it must be assertable without a DOM. The host-only surface renders
// these; it does not compute them.
import type { ConsentSurfaceGrant, ConsentSurfacePrincipal } from './principal-consent-surface-rows'

/** The renderer's read-only mirror of the registry's `PrincipalAuditAction` (§2a). */
export type ConsentAuditAction = 'create-principal' | 'bind' | 'unbind' | 'designate' | 'link-bind'

/** One audit row as delivered over the host-only IPC seam — the registry row, verbatim. */
export type ConsentAuditRow = {
  at: number
  action: ConsentAuditAction
  principalId: string | null
  deviceId?: string
  direction?: 'bind' | 'unbind'
  homePeerFingerprint?: string
  designatedGrantId?: string | null
}

export type ConsentAuditRowView = {
  at: number
  action: ConsentAuditAction
  /** The person the row names, resolved to a display name; the raw id when the principal is gone. */
  principalLabel: string | null
  /** The device the row names, resolved to its grant name; the short id prefix when the grant is gone. */
  deviceLabel: string | null
  /** Only bind/unbind carry a direction (§2a rule (iii)). */
  direction?: 'bind' | 'unbind'
}

const SHORT_ID_LENGTH = 8

/**
 * Resolve one audit row to its display labels (S9 §2a).
 *
 * A row can name a principal or device that no longer exists — an unbind of a since-deleted grant,
 * a create of a since-removed principal — so the join falls back to the raw id (short-prefixed for
 * a device) rather than dropping the row: the whole point of the log is that deletions stay visible.
 */
export function describeConsentAuditRow(
  row: ConsentAuditRow,
  context: {
    principals: readonly ConsentSurfacePrincipal[]
    grants: readonly ConsentSurfaceGrant[]
  }
): ConsentAuditRowView {
  const principalLabel = row.principalId
    ? (context.principals.find((principal) => principal.principalId === row.principalId)
        ?.displayName ?? row.principalId)
    : null
  // `designate` names its subject in `designatedGrantId`; the rest name it in `deviceId`.
  const deviceId = row.deviceId ?? row.designatedGrantId ?? null
  const deviceLabel = deviceId
    ? (context.grants.find((grant) => grant.deviceId === deviceId)?.name ??
      deviceId.slice(0, SHORT_ID_LENGTH))
    : null
  return {
    at: row.at,
    action: row.action,
    principalLabel,
    deviceLabel,
    ...(row.direction ? { direction: row.direction } : {})
  }
}
