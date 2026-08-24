import { existsSync, readFileSync } from 'node:fs'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'

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
  | 'provision'

/** §6 gate acceptance recorded on a `provision` audit row (B2's operator override). */
export type PrincipalPlatformAcceptance = 'unverified-win32' | 'unverified-darwin'

export type PrincipalAuditRow = {
  at: number
  action: PrincipalAuditAction
  principalId: string | null
  deviceId?: string
  /** Only bind/unbind carry a direction; designate carries none (§2a rule (iii)). */
  direction?: 'bind' | 'unbind'
  homePeerFingerprint?: string
  designatedGrantId?: string | null
  /** Only a `provision` row on a §6-gated platform carries this — the operator's override. */
  platformAcceptance?: PrincipalPlatformAcceptance
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

/** Moved out of `principal-registry.ts` to hold that file under the line ceiling. */
export function validatePrincipalDisplayName(displayName: string): string {
  const trimmed = displayName.trim()
  const hasControlCharacters = Array.from(trimmed).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f
  })
  if (!trimmed || trimmed.length > PRINCIPAL_DISPLAY_NAME_MAX_LENGTH || hasControlCharacters) {
    throw new ClaudeLaneRefusal(
      'accounts.lane.display_name_invalid',
      `A person’s name must be 1 to ${PRINCIPAL_DISPLAY_NAME_MAX_LENGTH} printable characters. Pick a shorter, plain-text name.`
    )
  }
  return trimmed
}
