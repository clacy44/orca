import type { ClaudeCredentialIdentity } from './claude-credential-identity-types'

/**
 * The SECRETLESS record of what a principal's credential lane last held (S9 §2c).
 *
 * It carries a sha256 of the refresh token and never the token, so the freshness rule a push is
 * checked against — and the residency key L1 rests on — can live in ordinary persisted settings
 * without putting a single-use credential there.
 */
export type ClaudeLaneCredentialWatermark = {
  /** The principal id whose lane this is; a lane is addressed by nothing else. */
  laneId: string
  identity: ClaudeCredentialIdentity
  refreshTokenSha256: string | null
  expiresAt: number | null
  /**
   * The lane's own copy can no longer refresh, so only a fresh login recovers it.
   *
   * It lives on the persisted row rather than in memory because it is the half that must outlive
   * a restart: the sha it holds is the ROTATED one, and a hold that evaporated would let
   * `syncLane` walk the watermark back onto the spent blob still sitting in the lane file.
   */
  reauthRequired?: boolean
}

// Why: bounds a corrupt/bloated persisted list — one row per provisioned lane, and a host has few.
export const MAX_CLAUDE_LANE_WATERMARKS = 64

/**
 * Validates every field on load: a row whose sha is not a sha, or whose identity is not an
 * object, would otherwise be compared against a real push and silently decide freshness.
 */
export function normalizeClaudeLaneWatermarks(value: unknown): ClaudeLaneCredentialWatermark[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: ClaudeLaneCredentialWatermark[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const row = normalizeClaudeLaneWatermark(entry)
    if (!row || seen.has(row.laneId)) {
      continue
    }
    seen.add(row.laneId)
    rows.push(row)
    if (rows.length >= MAX_CLAUDE_LANE_WATERMARKS) {
      break
    }
  }
  return rows
}

export function normalizeClaudeLaneWatermark(value: unknown): ClaudeLaneCredentialWatermark | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const laneId = record.laneId
  if (typeof laneId !== 'string' || laneId.length === 0 || laneId.length > 128) {
    return null
  }
  const identity = record.identity
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    return null
  }
  const identityRecord = identity as Record<string, unknown>
  return {
    laneId,
    identity: {
      accountUuid: readIdentityString(identityRecord.accountUuid),
      email: readIdentityString(identityRecord.email),
      organizationUuid: readIdentityString(identityRecord.organizationUuid)
    },
    refreshTokenSha256: isSha256Hex(record.refreshTokenSha256)
      ? (record.refreshTokenSha256 as string)
      : null,
    expiresAt:
      typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
        ? record.expiresAt
        : null,
    // Anything but a literal `true` is no hold: a corrupt row must not strand a lane.
    reauthRequired: record.reauthRequired === true
  }
}

function isSha256Hex(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function readIdentityString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
}
