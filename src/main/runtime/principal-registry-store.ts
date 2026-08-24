import { existsSync, readFileSync } from 'node:fs'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'

export const PRINCIPAL_REGISTRY_FILENAME = 'claude-principals.json'

// Why: the audit is a local forensic trail for mis-ticks, not a ledger; bound it so a long-lived
// host cannot grow the file without limit.
export const PRINCIPAL_AUDIT_MAX_ROWS = 500

export const PRINCIPAL_DISPLAY_NAME_MAX_LENGTH = 64

export type PrincipalRecord = {
  principalId: string
  displayName: string
  createdAt: number
  /** The one grant permitted to push into this principal's lane (S9 §2e). */
  delegatedGrantId?: string
}

export type PrincipalGrantBinding = {
  deviceId: string
  principalId: string
  boundAt: number
}

/**
 * A federated link's binding, keyed by its home-peer fingerprint and carrying NO principal of its
 * own: the create reads `principalOf(boundDeviceId)`, so there is one authority and no second
 * copy to disagree with it (§2a, rev 17).
 */
export type PrincipalLinkBinding = {
  homePeerFingerprint: string
  boundDeviceId: string
  boundAt: number
}

export type PrincipalAuditAction =
  | 'create-principal'
  | 'bind'
  | 'unbind'
  | 'designate'
  | 'link-bind'

export type PrincipalAuditRow = {
  at: number
  action: PrincipalAuditAction
  principalId: string | null
  deviceId?: string
  /** Only bind/unbind carry a direction; designate carries none (§2a rule (iii)). */
  direction?: 'bind' | 'unbind'
  homePeerFingerprint?: string
  designatedGrantId?: string | null
}

export type PrincipalRegistryState = {
  principals: PrincipalRecord[]
  bindings: PrincipalGrantBinding[]
  linkBindings: PrincipalLinkBinding[]
  audit: PrincipalAuditRow[]
}

export function emptyPrincipalRegistryState(): PrincipalRegistryState {
  return { principals: [], bindings: [], linkBindings: [], audit: [] }
}

export type PrincipalRegistryLoad = {
  state: PrincipalRegistryState
  loadSucceeded: boolean
}

/**
 * Reads the registry, reporting whether the read actually happened.
 *
 * A missing file is an authoritative empty registry; a parse failure is not, and callers that
 * delete things must be able to tell the two apart — the same distinction `DeviceRegistry.load`
 * draws for the same reason.
 */
export function loadPrincipalRegistryState(registryPath: string): PrincipalRegistryLoad {
  if (!existsSync(registryPath)) {
    return { state: emptyPrincipalRegistryState(), loadSucceeded: true }
  }
  try {
    hardenExistingSecureFile(registryPath)
    const parsed = JSON.parse(
      readFileSync(registryPath, 'utf-8')
    ) as Partial<PrincipalRegistryState>
    return {
      state: {
        principals: normalizeArray(parsed.principals),
        bindings: normalizeArray(parsed.bindings),
        linkBindings: normalizeArray(parsed.linkBindings),
        audit: normalizeArray(parsed.audit)
      },
      loadSucceeded: true
    }
  } catch {
    return { state: emptyPrincipalRegistryState(), loadSucceeded: false }
  }
}

export function savePrincipalRegistryState(
  registryPath: string,
  state: PrincipalRegistryState
): void {
  writeSecureJsonFile(registryPath, {
    ...state,
    audit: state.audit.slice(-PRINCIPAL_AUDIT_MAX_ROWS)
  })
}

function normalizeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}
