import type { ClaudeCredentialIdentity } from './claude-credential-identity-types'
import type { RuntimeTerminalLaneState } from './runtime-types'

/**
 * The lane status shape a lane publishes (S9 §2l, rev 32 credential-source re-basing, §10(g)).
 *
 * The delegable-account list, its tokens and `accounts.lane.setDelegableAccounts` are deleted in
 * S9-L3: under per-lane login the phone taps the lane's OWN account list (rev 32, §3 row 12).
 */

/** §2b's owner-authored per-account name. */
export const LANE_DISPLAY_NAME_MAX_LENGTH = 64

/** What `accounts.lane.status` answers and the status stream republishes. */
export type ClaudeLaneStatus = {
  laneId: string
  laneState: RuntimeTerminalLaneState
  /** Additive (Rule 1): an old client renders `absent` alone — conservative, per §2f. */
  laneWipePending?: boolean
  /** §2d(i): the grant that may start a login and see the URL, re-meant from "may push" (rev 32). */
  delegatedGrantId: string | null
  /** Whether the caller's own grant holds that designation. */
  callerIsDelegatedGrant: boolean
  heldDisplayName: string | null
  heldIdentity: ClaudeCredentialIdentity | null
  refreshTokenSha256: string | null
  expiresAt: number | null
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

// The control-character check runs on the RAW value: `trim()` eats tabs and newlines, so
// checking after it would silently ACCEPT the very strings §2b says to reject.
export function normalizeLaneDisplayName(value: unknown): string | null {
  if (typeof value !== 'string' || !isPrintableLaneString(value)) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length === 0 || trimmed.length > LANE_DISPLAY_NAME_MAX_LENGTH ? null : trimmed
}
