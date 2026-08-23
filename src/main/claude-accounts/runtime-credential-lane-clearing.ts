import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { ClaudeCredentialIdentity } from '../../shared/claude-credential-identity-types'
import {
  readIdentityFromCredentials,
  readIdentityFromOauthAccount
} from './claude-credential-identity'
import { isKnownDifferentAccount } from './principal-lane-store'
import { readJsonObjectFile, writeOauthAccountIntoConfigFile } from './lane-credential-writer'

/**
 * §2e rule (iv) on the delegating desktop: the THIRD copy rules (i) and (ii) never reach.
 *
 * `selectClaude` on this machine materializes the account's blob into its own runtime
 * `~/.claude` / `%USERPROFILE%\.claude`, and the host's residency index cannot see it — by its own
 * admission it enumerates lanes on THIS host only. A plain `claude` in any non-Orca terminal then
 * reads that file and rotates the lane's single-use refresh token. So taking the lease is a
 * CLEARING action, not only a refusal.
 *
 * It clears only when the runtime file holds the delegated account: an unrelated login on this
 * machine is not the lease's business, and signing it out would be hostile.
 */

export type RuntimeCredentialPaths = {
  credentialsPath: string
  configPath: string
  configDir: string
}

export type RuntimeCredentialClearOptions = {
  platform?: NodeJS.Platform
  /** darwin's scoped Keychain item resolves ahead of the file for Claude Code 2.1+. */
  deleteKeychainItem?: (configDir: string) => Promise<void> | void
}

export type RuntimeCredentialClearResult = {
  cleared: boolean
  reason: 'cleared' | 'absent' | 'different-account'
}

export function clearRuntimeCredentialsForDelegatedAccount(
  paths: RuntimeCredentialPaths,
  delegated: ClaudeCredentialIdentity,
  options: RuntimeCredentialClearOptions = {}
): RuntimeCredentialClearResult {
  const credentialsJson = readFileIfPresent(paths.credentialsPath)
  const configOauthAccount = readJsonObjectFile(paths.configPath)?.oauthAccount ?? null
  if (credentialsJson === null && configOauthAccount === null) {
    return { cleared: false, reason: 'absent' }
  }
  const resident = mergeIdentity(
    (credentialsJson ? readIdentityFromCredentials(credentialsJson) : null) ?? emptyIdentity(),
    readIdentityFromOauthAccount(configOauthAccount)
  )
  // A KNOWN different account is left alone; an unknown one is cleared, because the failure this
  // rule prevents is a plain `claude` rotating a token Orca cannot prove is not the lane's.
  if (isKnownDifferentAccount(resident, delegated)) {
    return { cleared: false, reason: 'different-account' }
  }
  if ((options.platform ?? process.platform) === 'darwin' && options.deleteKeychainItem) {
    void options.deleteKeychainItem(paths.configDir)
  }
  if (credentialsJson !== null) {
    rmSync(paths.credentialsPath, { force: true })
  }
  if (configOauthAccount !== null) {
    writeOauthAccountIntoConfigFile(paths.configPath, null)
  }
  return { cleared: true, reason: 'cleared' }
}

function readFileIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null
  } catch {
    return null
  }
}

function emptyIdentity(): ClaudeCredentialIdentity {
  return { accountUuid: null, email: null, organizationUuid: null }
}

function mergeIdentity(
  primary: ClaudeCredentialIdentity,
  fallback: ClaudeCredentialIdentity
): ClaudeCredentialIdentity {
  return {
    accountUuid: primary.accountUuid ?? fallback.accountUuid,
    email: primary.email ?? fallback.email,
    organizationUuid: primary.organizationUuid ?? fallback.organizationUuid
  }
}
