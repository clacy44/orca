import { createHash } from 'node:crypto'

/**
 * The identity and refresh-token readers `runtime-auth-service.ts` already used privately,
 * extracted so a lane reads a credential blob through the SAME comparator the shared runtime
 * does (S9 §2c/§2e). A second copy could only drift, and the drift would be a residency-index
 * miss — the exact double-residency L1 exists to prevent.
 */

export type ClaudeCredentialIdentity = {
  accountUuid: string | null
  email: string | null
  organizationUuid: string | null
}

export type ClaudeRefreshTokenComparison = 'same' | 'different' | 'missing'

export function asJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

export function readJsonString(value: Record<string, unknown> | null, key: string): string | null {
  const candidate = value?.[key]
  return typeof candidate === 'string' ? candidate : null
}

export function readJsonNumber(value: Record<string, unknown> | null, key: string): number | null {
  const candidate = value?.[key]
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    return candidate
  }
  if (typeof candidate === 'string') {
    const parsed = Number(candidate)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function normalizeIdentityField(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function readIdentityFromCredentials(
  credentialsJson: string
): ClaudeCredentialIdentity | null {
  const oauth = readOauthBlock(credentialsJson)
  if (oauth === undefined) {
    return null
  }
  return {
    accountUuid: normalizeIdentityField(
      readJsonString(oauth, 'accountUuid') ?? readJsonString(oauth, 'accountId')
    ),
    email: normalizeIdentityField(readJsonString(oauth, 'email')),
    organizationUuid: normalizeIdentityField(
      readJsonString(oauth, 'organizationUuid') ?? readJsonString(oauth, 'organizationId')
    )
  }
}

/** `oauth-account.json` spells the same three fields differently from `.credentials.json`. */
export function readIdentityFromOauthAccount(oauthAccount: unknown): ClaudeCredentialIdentity {
  const oauth = asJsonRecord(oauthAccount)
  return {
    accountUuid: normalizeIdentityField(
      readJsonString(oauth, 'accountUuid') ?? readJsonString(oauth, 'accountId')
    ),
    email: normalizeIdentityField(
      readJsonString(oauth, 'emailAddress') ?? readJsonString(oauth, 'email')
    ),
    organizationUuid: normalizeIdentityField(
      readJsonString(oauth, 'organizationUuid') ?? readJsonString(oauth, 'organizationId')
    )
  }
}

export function readRefreshTokenFromCredentials(credentialsJson: string): string | null {
  const oauth = readOauthBlock(credentialsJson)
  return oauth === undefined ? null : normalizeIdentityField(readJsonString(oauth, 'refreshToken'))
}

/** `missing` when either side has no refresh token — never conflated with `different`. */
export function compareRefreshTokens(
  leftCredentialsJson: string,
  rightCredentialsJson: string
): ClaudeRefreshTokenComparison {
  const left = readRefreshTokenFromCredentials(leftCredentialsJson)
  const right = readRefreshTokenFromCredentials(rightCredentialsJson)
  if (!left || !right) {
    return 'missing'
  }
  return left === right ? 'same' : 'different'
}

export function readFreshnessFromCredentials(credentialsJson: string): number | null {
  const oauth = readOauthBlock(credentialsJson)
  if (oauth === undefined) {
    return null
  }
  return (
    readJsonNumber(oauth, 'expiresAt') ??
    readJsonNumber(oauth, 'expires_at') ??
    readJsonNumber(oauth, 'expiry') ??
    readJsonNumber(oauth, 'expires')
  )
}

/**
 * The residency and watermark key for a credential.
 *
 * The digest is what gets persisted and compared; the token itself never leaves the lane file,
 * so nothing downstream of this call can leak it into settings, a log line or a wire frame.
 */
export function hashRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken, 'utf-8').digest('hex')
}

export function readRefreshTokenSha256(credentialsJson: string): string | null {
  const token = readRefreshTokenFromCredentials(credentialsJson)
  return token === null ? null : hashRefreshToken(token)
}

/** `undefined` distinguishes unparseable bytes from a parsed blob with no oauth block. */
function readOauthBlock(credentialsJson: string): Record<string, unknown> | null | undefined {
  try {
    return asJsonRecord(asJsonRecord(JSON.parse(credentialsJson))?.claudeAiOauth)
  } catch {
    return undefined
  }
}
