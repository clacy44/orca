import type { ClaudeCredentialIdentity } from './claude-credential-identity-types'
import type { RuntimeTerminalLaneState } from './runtime-types'

/**
 * The SECRETLESS delegation state a lane publishes, and the persisted rows behind it (S9 §2l).
 *
 * Nothing here is a credential: the delegable list carries host-minted opaque tokens and
 * owner-authored display strings, so the phone can name an account without the host ever
 * receiving the desktop's account inventory (§2b).
 */

/** §2b's owner-authored per-account name, and §2l's display fields, share this bound. */
export const LANE_DISPLAY_NAME_MAX_LENGTH = 64
export const LANE_ACCOUNT_EMAIL_MAX_LENGTH = 254
/** One list per lane, and a person has few accounts; bounds a corrupt or hostile write. */
export const MAX_LANE_DELEGABLE_ACCOUNTS = 32
export const MAX_LANE_DELEGATION_ROWS = 64
/** The desktop's own opaque handle for one of its accounts — never an account id (§2l). */
export const LANE_CLIENT_REF_MAX_LENGTH = 64

/** One account the owner ticked as switchable from their phone. */
export type ClaudeLaneDelegableAccount = {
  /** Host-minted random token. The phone names this and nothing else. */
  delegatedAccountId: string
  /** The desktop's own opaque handle, echoed back so it can map a request to its account. */
  clientRef: string
  displayName: string | null
  /** Present only where the owner opted the email in (Q3). */
  email: string | null
}

/** The persisted per-lane delegation row: the tokens outlive the socket that minted them. */
export type ClaudeLaneDelegationRow = {
  laneId: string
  /** The owner-authored name of the account the lane currently holds (§2b's third member). */
  heldDisplayName: string | null
  /** §2e: an explicit `accounts.lane.clear` happened and no push has landed since. */
  delegationCleared?: boolean
  /** Which delegable token the lane actually holds — a stable id, never a comparable name. */
  heldDelegatedAccountId?: string | null
  delegable: ClaudeLaneDelegableAccount[]
}

/** What `accounts.lane.status` answers and the status stream republishes. */
export type ClaudeLaneStatus = {
  laneId: string
  laneState: RuntimeTerminalLaneState
  /** Additive (Rule 1): an old client renders `absent` alone — conservative, per §2f. */
  laneWipePending?: boolean
  /** §2e: every bound desktop reads this to suppress its OWN rotation, the holder included. */
  delegatedGrantId: string | null
  /**
   * Additive (Rule 1): one of §2e's exactly three lease releases. `laneState: 'absent'` cannot
   * carry it — §2f's close-wipe is absent too and must NOT release — and `clear` deliberately
   * keeps both the watermark and the designation, so nothing else in this row changes on a clear.
   */
  delegationCleared?: boolean
  /** Whether the caller's own grant is the designated pusher. */
  callerIsDelegatedGrant: boolean
  heldDisplayName: string | null
  /**
   * Additive (Rule 1): the delegable token the lane holds, so a client can mark the loaded row
   * without comparing two nullable owner-authored names — `null === null` marked every row.
   */
  heldDelegatedAccountId?: string | null
  heldIdentity: ClaudeCredentialIdentity | null
  refreshTokenSha256: string | null
  expiresAt: number | null
  delegable: ClaudeLaneDelegableAccount[]
}

/** Rejects the control range outright rather than stripping it: §2b refuses, never sanitizes. */
export function isPrintableLaneString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      return false
    }
  }
  return value.length > 0
}

export function normalizeLaneDisplayName(value: unknown): string | null {
  return normalizeBoundedLaneString(value, LANE_DISPLAY_NAME_MAX_LENGTH)
}

export function normalizeClaudeLaneDelegationRows(value: unknown): ClaudeLaneDelegationRow[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: ClaudeLaneDelegationRow[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const row = normalizeClaudeLaneDelegationRow(entry)
    if (!row || seen.has(row.laneId)) {
      continue
    }
    seen.add(row.laneId)
    rows.push(row)
    if (rows.length >= MAX_LANE_DELEGATION_ROWS) {
      break
    }
  }
  return rows
}

export function normalizeClaudeLaneDelegationRow(value: unknown): ClaudeLaneDelegationRow | null {
  const record = asRecord(value)
  const laneId = record?.laneId
  if (typeof laneId !== 'string' || laneId.length === 0 || laneId.length > 128) {
    return null
  }
  const heldDelegatedAccountId = record?.heldDelegatedAccountId
  return {
    laneId,
    heldDisplayName: normalizeLaneDisplayName(record?.heldDisplayName),
    ...(record?.delegationCleared === true ? { delegationCleared: true } : {}),
    ...(typeof heldDelegatedAccountId === 'string' &&
    heldDelegatedAccountId.length > 0 &&
    heldDelegatedAccountId.length <= 128
      ? { heldDelegatedAccountId }
      : {}),
    delegable: normalizeDelegableAccounts(record?.delegable)
  }
}

export function normalizeDelegableAccounts(value: unknown): ClaudeLaneDelegableAccount[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: ClaudeLaneDelegableAccount[] = []
  const seenTokens = new Set<string>()
  for (const entry of value) {
    const record = asRecord(entry)
    const delegatedAccountId = record?.delegatedAccountId
    const clientRef = record?.clientRef
    if (
      typeof delegatedAccountId !== 'string' ||
      delegatedAccountId.length === 0 ||
      delegatedAccountId.length > 128 ||
      seenTokens.has(delegatedAccountId) ||
      typeof clientRef !== 'string' ||
      clientRef.length === 0 ||
      clientRef.length > LANE_CLIENT_REF_MAX_LENGTH
    ) {
      continue
    }
    seenTokens.add(delegatedAccountId)
    rows.push({
      delegatedAccountId,
      clientRef,
      displayName: normalizeLaneDisplayName(record?.displayName),
      email: normalizeBoundedLaneString(record?.email, LANE_ACCOUNT_EMAIL_MAX_LENGTH)
    })
    if (rows.length >= MAX_LANE_DELEGABLE_ACCOUNTS) {
      break
    }
  }
  return rows
}

// The control-character check runs on the RAW value: `trim()` eats tabs and newlines, so
// checking after it would silently ACCEPT the very strings §2b says to reject.
function normalizeBoundedLaneString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || !isPrintableLaneString(value)) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length === 0 || trimmed.length > maxLength ? null : trimmed
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}
