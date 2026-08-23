import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { readIdentityFromOauthAccount, readRefreshTokenSha256 } from './claude-credential-identity'
import { readClaudeManagedAuthFile, resolveOwnedClaudeManagedAuthPath } from './managed-auth-path'
import type { AccountResidencyIndex } from './account-residency-index'

/**
 * L1's second edge on the MANAGED side (S9 §2d/§2e).
 *
 * `selectClaude` and `removeClaude` name an Orca account id; the residency index keys rows by
 * `accountUuid` and `sha256(refreshToken)`. This resolves the one into the other by reading the
 * account's own managed auth files, so the same `assertNotLaneResident` predicate answers for
 * every caller class — the renderer and the anonymous local socket included, which is the point:
 * neither of them carries a `pairedDeviceId` the RPC layer could gate on.
 *
 * Attached as a module singleton so the two ratcheted funnels (`claude-accounts/service.ts`) take
 * a delegating call and grow no dependencies. With nothing attached the guard is inert, which is
 * the pre-lane host exactly as it behaves today.
 */

export type ManagedAccountLookup = {
  findAccount(accountId: string): ClaudeManagedAccount | null
}

export type ManagedAccountResidencyGuardOptions = {
  residency: AccountResidencyIndex
  accounts: ManagedAccountLookup
  /** Injected for tests; production proves the account's own Orca-owned auth directory. */
  resolveManagedAuthPath?: (accountId: string, candidatePath: string) => string | null
  readManagedAuthFile?: (
    managedAuthPath: string,
    fileName: '.credentials.json' | 'oauth-account.json'
  ) => string | null
  /** L1's second edge cannot answer for an account whose store it cannot read (below). */
  onResidencyUnverifiable?: (accountId: string, reason: ResidencyUnverifiableReason) => void
}

/** Never a path and never a token: an id and why the keys could not be derived. */
export type ResidencyUnverifiableReason = 'auth-path-unresolved' | 'auth-files-unreadable'

export class ManagedAccountResidencyGuard {
  constructor(private readonly options: ManagedAccountResidencyGuardOptions) {}

  /**
   * Refuses `accounts.lane.account_resident_elsewhere`, naming the holding principal's label.
   *
   * An account Orca does not manage is genuinely out of scope and returns silently. An account it
   * DOES manage whose auth files it cannot read is a different thing — the edge fails OPEN, and
   * §2d states the refusal with no exemption — so that case is reported rather than merely passing.
   */
  assertNotLaneResident(accountId: string): void {
    const account = this.options.accounts.findAccount(accountId)
    if (!account) {
      return
    }
    const resolvePath = this.options.resolveManagedAuthPath ?? resolveOwnedClaudeManagedAuthPath
    const managedAuthPath = resolvePath(account.id, account.managedAuthPath)
    if (!managedAuthPath) {
      this.reportUnverifiable(accountId, 'auth-path-unresolved')
      return
    }
    const read = this.options.readManagedAuthFile ?? readClaudeManagedAuthFile
    const credentialsJson = read(managedAuthPath, '.credentials.json')
    const oauthAccountJson = read(managedAuthPath, 'oauth-account.json')
    if (credentialsJson === null && oauthAccountJson === null) {
      this.reportUnverifiable(accountId, 'auth-files-unreadable')
      return
    }
    this.options.residency.assertNotLaneResident({
      accountId,
      accountUuid: readIdentityFromOauthAccount(parseJson(oauthAccountJson)).accountUuid,
      refreshTokenSha256: credentialsJson ? readRefreshTokenSha256(credentialsJson) : null
    })
  }

  private reportUnverifiable(accountId: string, reason: ResidencyUnverifiableReason): void {
    const report = this.options.onResidencyUnverifiable ?? warnResidencyUnverifiable
    report(accountId, reason)
  }
}

function warnResidencyUnverifiable(accountId: string, reason: ResidencyUnverifiableReason): void {
  console.warn(
    `[claude-accounts] Could not check lane residency for managed account ${accountId} (${reason}); L1's second edge did not run for it.`
  )
}

let attachedGuard: ManagedAccountResidencyGuard | null = null

export function attachManagedAccountResidencyGuard(
  guard: ManagedAccountResidencyGuard | null
): void {
  attachedGuard = guard
}

/** The delegating call the two account funnels take; a no-op on a host with no lanes. */
export function assertManagedClaudeAccountNotLaneResident(accountId: string | null): void {
  if (accountId === null) {
    return
  }
  attachedGuard?.assertNotLaneResident(accountId)
}

function parseJson(contents: string | null): unknown {
  if (!contents) {
    return null
  }
  try {
    return JSON.parse(contents) as unknown
  } catch {
    return null
  }
}
