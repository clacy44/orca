/**
 * The delegation lease, as the DESKTOP persists it (S9 §2e).
 *
 * It is a cache of a value the host publishes, not an authority: on reconnect the host's value
 * wins. What makes it durable rather than process-local is the failure it exists to prevent — a
 * desktop restart must not un-suppress a rotator whose token the host lane's live `claude` holds.
 *
 * Nothing here is a credential: an account id the desktop already owns, the host and principal it
 * was delegated to, and the grant the human designated.
 */
export type ClaudeLaneDelegationLease = {
  /** The DESKTOP's own managed account id — the only id this side has for the account. */
  accountId: string
  /** Identity as the host published it, so a re-published status can be matched to this row. */
  accountUuid: string | null
  hostId: string
  principalId: string
  delegatedGrantId: string
  since: number
  /** §2e's expiry arm: after this the lease is inert, so a dead host cannot suppress forever. */
  expiresAt: number | null
  /**
   * Q3's editable friendly name for this delegated account, persisted WITH the lease so the desktop
   * shows a human name ("work", "personal") instead of the opaque account id. Renewal preserves it;
   * absent until the human sets one.
   */
  friendlyName?: string | null
  /**
   * Additive (Rule 1): true when this account was THIS desktop's own active local selection at
   * lease-creation time. Rule (iv) clears its runtime file the instant the lease is taken, so a
   * signed-in local Claude session goes to "Not logged in" with no warning — this flag is what lets
   * Release re-select the account locally afterward, undoing that sign-out.
   */
  wasLocalActive?: boolean
}

/** One row per delegated account; a desktop delegates few, and a corrupt list must stay bounded. */
export const MAX_CLAUDE_LANE_LEASES = 64

/** A lease outlives disconnects by design, so its expiry is long — a week, not a session. */
export const CLAUDE_LANE_LEASE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function normalizeClaudeLaneLeases(value: unknown): ClaudeLaneDelegationLease[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: ClaudeLaneDelegationLease[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const row = normalizeClaudeLaneLease(entry)
    if (!row || seen.has(row.accountId)) {
      continue
    }
    seen.add(row.accountId)
    rows.push(row)
    if (rows.length >= MAX_CLAUDE_LANE_LEASES) {
      break
    }
  }
  return rows
}

export function normalizeClaudeLaneLease(value: unknown): ClaudeLaneDelegationLease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const accountId = readBounded(record.accountId, 256)
  const hostId = readBounded(record.hostId, 256)
  const principalId = readBounded(record.principalId, 128)
  const delegatedGrantId = readBounded(record.delegatedGrantId, 256)
  if (!accountId || !hostId || !principalId || !delegatedGrantId) {
    return null
  }
  const friendlyName = readBounded(record.friendlyName, 128)
  return {
    accountId,
    accountUuid: readBounded(record.accountUuid, 256),
    hostId,
    principalId,
    delegatedGrantId,
    since: readTimestamp(record.since) ?? 0,
    expiresAt: readTimestamp(record.expiresAt),
    ...(friendlyName ? { friendlyName } : {}),
    ...(record.wasLocalActive === true ? { wasLocalActive: true } : {})
  }
}

function readBounded(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null
}

function readTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
