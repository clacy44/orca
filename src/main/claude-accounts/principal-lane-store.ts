import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import {
  readFreshnessFromCredentials,
  readIdentityFromCredentials,
  readIdentityFromOauthAccount,
  readRefreshTokenSha256,
  type ClaudeCredentialIdentity
} from './claude-credential-identity'
import { LaneCredentialWriter, readJsonObjectFile } from './lane-credential-writer'
import { isLaneWipePending } from './lane-wipe-pending'
import {
  getPrincipalLaneDir,
  resolveOwnedPrincipalLaneDir,
  type PrincipalLaneOptions
} from './principal-credential-lane'
import {
  LANE_CONFIG_FILENAME,
  LANE_CREDENTIALS_FILENAME,
  isLaneLoaded
} from './principal-lane-credential-sweep'

/** What a lane's file currently holds. Never carries the token itself. */
export type LaneCredentialState = {
  laneId: string
  identity: ClaudeCredentialIdentity
  refreshTokenSha256: string | null
  expiresAt: number | null
}

/**
 * Per-lane credential state: what the lane holds, read live off its own file (S9 §2c, rev 32).
 *
 * Rev 32 deletes the watermark and its three push-freshness writers: the lane's own CLI is the
 * only writer to its file now, so there is no desktop-asserted `basedOn` claim left to judge a
 * write against, and the state below is always a live read rather than a cached, persisted one.
 */
export class PrincipalLaneStore {
  /** Writing through this directly skips §2c's ordering: take `serializeLaneWrite` around it. */
  readonly writer = new LaneCredentialWriter()

  constructor(private readonly laneOptions: PrincipalLaneOptions = {}) {}

  resolveLaneDir(laneId: string): string | null {
    return resolveOwnedPrincipalLaneDir(laneId, this.laneOptions)
  }

  /** Something is at the lane's path, ownership unproved — what "nothing to wipe" is judged by. */
  hasLaneDirectory(laneId: string): boolean {
    try {
      return existsSync(getPrincipalLaneDir(laneId, this.laneOptions))
    } catch {
      // A malformed principal id names no lane path at all.
      return false
    }
  }

  /**
   * A wipe-pending lane reads `absent` whatever is on disk (§2f): this is the value LAUNCHES key
   * on, and failing them closed is the right direction while the host is trying to empty the lane.
   *
   * `reauth-required` — the lane's own grant revoked upstream — is not detectable from this store
   * alone until S9-L1's login session lands its own identity check; a live terminal in that state
   * fails `invalid_grant` on its next refresh regardless of what this reports (§3's degradation
   * row).
   */
  getLaneState(laneId: string): RuntimeTerminalLaneState {
    const laneDir = this.resolveLaneDir(laneId)
    if (!laneDir || isLaneWipePending(laneId) || !isLaneLoaded(laneDir)) {
      return 'absent'
    }
    return 'loaded'
  }

  readLaneCredentials(laneId: string): string | null {
    const laneDir = this.resolveLaneDir(laneId)
    if (!laneDir) {
      return null
    }
    const credentialsPath = join(laneDir, LANE_CREDENTIALS_FILENAME)
    try {
      return existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf-8') : null
    } catch {
      return null
    }
  }

  readLaneOauthAccount(laneId: string): unknown {
    const laneDir = this.resolveLaneDir(laneId)
    if (!laneDir) {
      return null
    }
    return readJsonObjectFile(join(laneDir, LANE_CONFIG_FILENAME))?.oauthAccount ?? null
  }

  /** A live read of what the lane's own file currently holds — never a cached/persisted row. */
  getCredentialState(laneId: string): LaneCredentialState | null {
    const credentialsJson = this.readLaneCredentials(laneId)
    if (credentialsJson === null) {
      return null
    }
    return {
      laneId,
      identity: resolveLaneIdentity(credentialsJson, this.readLaneOauthAccount(laneId)),
      refreshTokenSha256: readRefreshTokenSha256(credentialsJson),
      expiresAt: readFreshnessFromCredentials(credentialsJson)
    }
  }
}

/** The lane's `oauth-account.json` is the richer identity; the blob's own is the fallback. */
export function resolveLaneIdentity(
  credentialsJson: string,
  oauthAccount: unknown
): ClaudeCredentialIdentity {
  const fromOauthAccount = readIdentityFromOauthAccount(oauthAccount)
  if (fromOauthAccount.accountUuid !== null || fromOauthAccount.email !== null) {
    return fromOauthAccount
  }
  return (
    readIdentityFromCredentials(credentialsJson) ?? {
      accountUuid: null,
      email: null,
      organizationUuid: null
    }
  )
}
