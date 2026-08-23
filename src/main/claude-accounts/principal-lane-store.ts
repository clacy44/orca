import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeLaneCredentialWatermark } from '../../shared/claude-lane-watermark'
import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import {
  readFreshnessFromCredentials,
  readIdentityFromCredentials,
  readIdentityFromOauthAccount,
  readRefreshTokenSha256,
  type ClaudeCredentialIdentity
} from './claude-credential-identity'
import { LaneCredentialWriter, readJsonObjectFile } from './lane-credential-writer'
import {
  resolveOwnedPrincipalLaneDir,
  type PrincipalLaneOptions
} from './principal-credential-lane'
import {
  LANE_CONFIG_FILENAME,
  LANE_CREDENTIALS_FILENAME,
  isLaneLoaded
} from './principal-lane-credential-sweep'

export type LaneRotationCause = 'host' | 'cli-observed' | 'foreign-rotation'

/** What a lane's credential became, and who moved it. Never carries the token itself. */
export type LaneRotationReceipt = {
  laneId: string
  identity: ClaudeCredentialIdentity
  refreshTokenSha256: string | null
  expiresAt: number | null
  cause: LaneRotationCause
}

export type LaneWatermarkPersistence = {
  getClaudeLaneCredentialWatermarks(): ClaudeLaneCredentialWatermark[]
  setClaudeLaneCredentialWatermarks(rows: readonly ClaudeLaneCredentialWatermark[]): void
}

export type LanePushFreshnessInput = {
  laneId: string
  credentialsJson: string
  basedOnRefreshTokenSha256: string | null
  /** The pushed `oauth-account.json`, read through the same identity reader the watermark uses. */
  oauthAccount?: unknown
  /** Client-asserted and therefore advisory: it excuses a stale sha, never an older blob. */
  reauthenticated?: boolean
}

/**
 * Per-lane credential state: what the lane holds, and the watermark every push is judged against.
 *
 * The watermark has THREE writers — `syncLane`, a successful push, and every rotation receipt.
 * With only the first, `syncLane` runs immediately before applying a push (trigger 3) and records
 * the PRE-push file, so the next push's `basedOn` mismatches and R2 works exactly once per lane
 * (S9 §2c).
 */
export class PrincipalLaneStore {
  /** Writing through this directly skips §2c's ordering: take `serializeLaneWrite` around it. */
  readonly writer = new LaneCredentialWriter()
  private readonly reauthRequiredLanes = new Set<string>()
  private readonly receiptListeners = new Set<(receipt: LaneRotationReceipt) => void>()

  constructor(
    private readonly persistence: LaneWatermarkPersistence,
    private readonly laneOptions: PrincipalLaneOptions = {}
  ) {}

  resolveLaneDir(laneId: string): string | null {
    return resolveOwnedPrincipalLaneDir(laneId, this.laneOptions)
  }

  /**
   * `reauth-required` is sticky until a credential lands: it is the outcome of a FOREIGN rotation,
   * which no file-presence check can see, so it must not be recomputed away by one.
   */
  getLaneState(laneId: string): RuntimeTerminalLaneState {
    const laneDir = this.resolveLaneDir(laneId)
    if (!laneDir || !isLaneLoaded(laneDir)) {
      return 'absent'
    }
    return this.reauthRequiredLanes.has(laneId) ? 'reauth-required' : 'loaded'
  }

  markReauthRequired(laneId: string): void {
    this.reauthRequiredLanes.add(laneId)
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

  getWatermark(laneId: string): ClaudeLaneCredentialWatermark | null {
    return (
      this.persistence.getClaudeLaneCredentialWatermarks().find((row) => row.laneId === laneId) ??
      null
    )
  }

  /** Writer 1: what `syncLane` observed on disk, on all four triggers. */
  recordSyncedLaneCredentials(
    laneId: string,
    credentialsJson: string,
    oauthAccount?: unknown
  ): ClaudeLaneCredentialWatermark {
    return this.writeWatermark(laneId, credentialsJson, oauthAccount)
  }

  /** Writer 2: the pushed blob, without which the SECOND push of a lane reads as stale. */
  recordPushedLaneCredentials(
    laneId: string,
    credentialsJson: string,
    oauthAccount?: unknown
  ): ClaudeLaneCredentialWatermark {
    this.reauthRequiredLanes.delete(laneId)
    return this.writeWatermark(laneId, credentialsJson, oauthAccount)
  }

  /**
   * Writer 3: a rotation, host-initiated or merely observed, and the receipt it publishes.
   *
   * DEVIATION from §2c, which names only `host` and `cli-observed` as writer 3: a
   * `foreign-rotation` moves the watermark too. Leaving it pinned would keep the SPENT sha as the
   * chain head, so the desktop's cached pre-rotation blob would pass the sha arm and be replayed
   * into a lane only a fresh login can recover. Moving it forces `reauthenticated: true`, which is
   * exactly what recovery is.
   */
  recordRotationReceipt(receipt: LaneRotationReceipt): void {
    if (receipt.cause === 'foreign-rotation') {
      this.reauthRequiredLanes.add(receipt.laneId)
    } else {
      this.reauthRequiredLanes.delete(receipt.laneId)
    }
    this.putWatermarkRow({
      laneId: receipt.laneId,
      identity: receipt.identity,
      refreshTokenSha256: receipt.refreshTokenSha256,
      expiresAt: receipt.expiresAt
    })
    for (const listener of this.receiptListeners) {
      listener(receipt)
    }
  }

  /**
   * A host rotation whose blob never reached the lane: the old token is spent either way.
   *
   * The watermark moves to the ROTATED sha so the desktop's cached pre-rotation blob cannot pass
   * the sha arm on reconnect, and the lane holds at `reauth-required` until a push lands. No
   * receipt: the lane does not hold this credential, and §2e's three causes all assert it does.
   */
  recordUnwritableRotation(
    laneId: string,
    rotatedCredentialsJson: string,
    oauthAccount?: unknown
  ): void {
    this.writeWatermark(laneId, rotatedCredentialsJson, oauthAccount)
    this.reauthRequiredLanes.add(laneId)
  }

  onRotationReceipt(listener: (receipt: LaneRotationReceipt) => void): () => void {
    this.receiptListeners.add(listener)
    return () => this.receiptListeners.delete(listener)
  }

  /**
   * The §2b freshness rule, checked BEFORE any write.
   *
   * `reauthenticated` is a client assertion — a fresh login legitimately breaks the sha chain —
   * so it excuses a mismatched `basedOn` and nothing else: a strictly older blob is refused under
   * it, because otherwise one flag replays a revoked credential back into the lane.
   */
  assertPushIsFresh(input: LanePushFreshnessInput): void {
    const watermark = this.getWatermark(input.laneId)
    if (!watermark) {
      return
    }
    if (
      !input.reauthenticated &&
      !matchesWatermarkSha(input.basedOnRefreshTokenSha256, watermark)
    ) {
      throw stalePushRefusal()
    }
    // The expiry arm backs the advisory flag WITHIN one token chain. An account switch is R2
    // itself, and the target account's own last refresh is legitimately older than the lane's.
    if (
      isKnownDifferentAccount(
        resolveLaneIdentity(input.credentialsJson, input.oauthAccount),
        watermark.identity
      )
    ) {
      return
    }
    const pushedExpiresAt = readFreshnessFromCredentials(input.credentialsJson)
    if (
      pushedExpiresAt !== null &&
      watermark.expiresAt !== null &&
      pushedExpiresAt < watermark.expiresAt
    ) {
      throw stalePushRefusal()
    }
  }

  private writeWatermark(
    laneId: string,
    credentialsJson: string,
    oauthAccount: unknown
  ): ClaudeLaneCredentialWatermark {
    const row: ClaudeLaneCredentialWatermark = {
      laneId,
      identity: resolveLaneIdentity(credentialsJson, oauthAccount),
      refreshTokenSha256: readRefreshTokenSha256(credentialsJson),
      expiresAt: readFreshnessFromCredentials(credentialsJson)
    }
    this.putWatermarkRow(row)
    return row
  }

  private putWatermarkRow(row: ClaudeLaneCredentialWatermark): void {
    const rows = this.persistence
      .getClaudeLaneCredentialWatermarks()
      .filter((existing) => existing.laneId !== row.laneId)
    this.persistence.setClaudeLaneCredentialWatermarks([...rows, row])
  }
}

/**
 * A null-sha watermark is a MISMATCH, never a wildcard.
 *
 * A blob carrying an access token and no refresh token watermarks a null sha; treating that as
 * "nothing to match" would let every later push name any `basedOn` at all.
 */
function matchesWatermarkSha(
  basedOnRefreshTokenSha256: string | null,
  watermark: ClaudeLaneCredentialWatermark
): boolean {
  return (
    watermark.refreshTokenSha256 !== null &&
    basedOnRefreshTokenSha256 === watermark.refreshTokenSha256
  )
}

/** Only a POSITIVELY different account skips the expiry backstop; an unknown identity keeps it. */
export function isKnownDifferentAccount(
  left: ClaudeCredentialIdentity,
  right: ClaudeCredentialIdentity
): boolean {
  if (left.accountUuid !== null && right.accountUuid !== null) {
    return left.accountUuid !== right.accountUuid
  }
  if (left.email !== null && right.email !== null) {
    return left.email !== right.email
  }
  return false
}

/** The pushed `oauth-account.json` is the richer identity; the blob's own is the fallback. */
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

function stalePushRefusal(): ClaudeLaneRefusal {
  return new ClaudeLaneRefusal(
    'accounts.lane.push_stale',
    'That Claude account was pushed from a copy that is older than what this host already holds for your lane, so Orca refused it rather than putting a revoked token back. Open Orca on the desktop that last switched this account and push again from there.'
  )
}
