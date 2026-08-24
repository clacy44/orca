import type { AccountResidencyIndex } from './account-residency-index'
import { compareRefreshTokens } from './claude-credential-identity'
import { hasClaudeOauthAccessToken } from './lane-credential-writer'
import { hasLiveClaudePtysInLane, hasUnattributedLiveClaudePtys } from './live-pty-gate'
import { isOauthTokenExpiring, refreshClaudeOauthCredentials } from './oauth-refresh'
import type { PrincipalLaneStore } from './principal-lane-store'

/**
 * `ClaudeRuntimeAuthService`'s eight process-global fields, re-keyed by (lane, account) (S9 §2e).
 *
 * The write queue is PER LANE — a slow write in one lane must not stall another person's launch —
 * while rotation stays serialized per ACCOUNT, because the single-use refresh token is an account
 * fact and L1 makes that axis single-valued across every lane.
 */

// Why visible, and why this: a lane id is a UUID, so `::` cannot occur on the left of the key and
// no accountUuid can forge a different lane's row by carrying one.
const LANE_ACCOUNT_KEY_SEPARATOR = '::'

export type LaneAccountAuthState = {
  lastSyncedAccountUuid: string | null
  lastWrittenCredentialsJson: string | null
  hasMaterializedLaneAuth: boolean
  hasLastWrittenOauthAccount: boolean
  lastWrittenOauthAccount: unknown
  skipNextReadBackForAccountUuid: string | null
  /** Account-keyed, exactly as the host's own field is: a lane-keyed one would be unsound. */
  refreshDeferredByLivePtyAccountUuid: string | null
}

export type LaneRotationOutcome =
  | { status: 'rotated'; credentialsJson: string }
  | { status: 'deferred' }
  | { status: 'not-expiring' }
  | { status: 'refresh-failed' }
  /** The lane went away (or its marker stopped validating) BEFORE the token was spent. */
  | { status: 'lane-unavailable' }
  /** The lane file no longer holds the blob we were asked to rotate; nothing was spent. */
  | { status: 'input-superseded' }
  /**
   * The token WAS spent and the lane could not be published — never a refresh failure.
   *
   * Deliberately the outcome of a PARTIAL publish too — a darwin Keychain refusal after the file
   * landed, a win32 DACL that would not verify after the rename — where the lane may hold a
   * working blob the host cannot vouch for. Failing closed and asking for a push is the safe
   * direction; `publishRotation` still records who wrote what is on disk.
   */
  | { status: 'lane-write-lost'; credentialsJson: string }

export type LaneAuthStateOptions = {
  store: PrincipalLaneStore
  residency: AccountResidencyIndex
  /** Injected so the rotation arms are observable without the token endpoint. */
  refreshCredentials?: (credentialsJson: string) => Promise<string | null>
  laneHasLivePtys?: (laneId: string) => boolean
  hasUnattributedLivePtys?: () => boolean
  isExpiring?: (credentialsJson: string) => boolean
}

export class LaneAuthState {
  private readonly statesByLaneAccount = new Map<string, LaneAccountAuthState>()
  private readonly writeQueueByLane = new Map<string, Promise<unknown>>()
  private readonly rotationQueueByAccount = new Map<string, Promise<unknown>>()

  constructor(private readonly options: LaneAuthStateOptions) {}

  getState(laneId: string, accountUuid: string | null): LaneAccountAuthState {
    const key = laneAccountKey(laneId, accountUuid)
    const existing = this.statesByLaneAccount.get(key)
    if (existing) {
      return existing
    }
    const fresh: LaneAccountAuthState = {
      lastSyncedAccountUuid: null,
      lastWrittenCredentialsJson: null,
      hasMaterializedLaneAuth: false,
      hasLastWrittenOauthAccount: false,
      lastWrittenOauthAccount: null,
      skipNextReadBackForAccountUuid: null,
      refreshDeferredByLivePtyAccountUuid: null
    }
    this.statesByLaneAccount.set(key, fresh)
    return fresh
  }

  forgetLane(laneId: string): void {
    const prefix = `${laneId}${LANE_ACCOUNT_KEY_SEPARATOR}`
    for (const key of this.statesByLaneAccount.keys()) {
      if (key.startsWith(prefix)) {
        this.statesByLaneAccount.delete(key)
      }
    }
  }

  /**
   * One queue per lane: lane A's slow write does not delay lane B's.
   *
   * §2c's ordering — validate, freshness-check, write, watermark — holds only for callers that
   * enter through here. `LaneSyncDriver.syncLane` does; the push handler must too, and it cannot
   * nest inside a sync's turn, which is why this is not folded into the store's writer.
   */
  serializeLaneWrite<T>(laneId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.writeQueueByLane.get(laneId) ?? Promise.resolve()).then(fn, fn)
    this.writeQueueByLane.set(
      laneId,
      next.catch(() => {})
    )
    return next
  }

  /** One queue per ACCOUNT: two lanes may not rotate the same single-use token concurrently. */
  serializeAccountRotation<T>(accountUuid: string | null, fn: () => Promise<T>): Promise<T> {
    const key = accountUuid ?? ''
    const next = (this.rotationQueueByAccount.get(key) ?? Promise.resolve()).then(fn, fn)
    this.rotationQueueByAccount.set(
      key,
      next.catch(() => {})
    )
    return next
  }

  /**
   * Whether a live `claude` holds THIS account's credential anywhere on the host.
   *
   * Resolved through the residency index — single-valued by L1 — over the lane-pinned live-PTY
   * set. A pty this process cannot attribute defers every account: over-deferring delays a
   * refresh, under-deferring revokes a token a running CLI still needs.
   */
  isRefreshDeferredByLivePty(account: {
    accountUuid: string | null
    refreshTokenSha256: string | null
  }): boolean {
    const hasUnattributed = this.options.hasUnattributedLivePtys ?? hasUnattributedLiveClaudePtys
    if (hasUnattributed()) {
      return true
    }
    const holder = this.options.residency.findLaneResidency(account)
    if (!holder) {
      return false
    }
    const laneHasLivePtys = this.options.laneHasLivePtys ?? hasLiveClaudePtysInLane
    return laneHasLivePtys(holder.laneId)
  }

  /**
   * Rotates a lane's credential and persists it through the LANE writer.
   *
   * Never through managed storage: `writeManagedCredentials` requires a `ClaudeManagedAccount`
   * and an Orca-owned `claude-accounts/<id>/auth` path, and a lane account has no managed record
   * on this host — the desktop never pushed one (§2b).
   *
   * The refresh endpoint SPENDS the single-use token, so everything that can refuse the write is
   * evaluated before it: a close-wipe landing during the round trip must not turn a spent token
   * into a silent `refresh-failed`, which is the `invalid_grant`-everywhere failure §2c opens by
   * describing, produced by the code that exists to prevent it.
   */
  async rotateLaneCredentials(input: {
    laneId: string
    accountUuid: string | null
    refreshTokenSha256: string | null
    credentialsJson: string
  }): Promise<LaneRotationOutcome> {
    const isExpiring = this.options.isExpiring ?? isOauthTokenExpiring
    if (!isExpiring(input.credentialsJson)) {
      return { status: 'not-expiring' }
    }
    return this.serializeAccountRotation(input.accountUuid, async () => {
      const state = this.getState(input.laneId, input.accountUuid)
      if (this.isRefreshDeferredByLivePty(input)) {
        state.refreshDeferredByLivePtyAccountUuid = input.accountUuid
        return { status: 'deferred' }
      }
      state.refreshDeferredByLivePtyAccountUuid = null
      const preflight = this.assertLaneStillHolds(input.laneId, input.credentialsJson)
      if (preflight) {
        return preflight
      }
      const refresh = this.options.refreshCredentials ?? refreshClaudeOauthCredentials
      const refreshed = await refresh(input.credentialsJson)
      if (!refreshed || !hasClaudeOauthAccessToken(refreshed)) {
        return { status: 'refresh-failed' }
      }
      return await this.publishRotation(input.laneId, input.accountUuid, refreshed, state)
    })
  }

  /** Re-reads the lane immediately before the token is spent; null means the rotation may run. */
  private assertLaneStillHolds(
    laneId: string,
    credentialsJson: string
  ): LaneRotationOutcome | null {
    if (!this.options.store.resolveLaneDir(laneId)) {
      return { status: 'lane-unavailable' }
    }
    const onDisk = this.options.store.readLaneCredentials(laneId)
    if (onDisk === null || compareRefreshTokens(onDisk, credentialsJson) !== 'same') {
      return { status: 'input-superseded' }
    }
    return null
  }

  private async publishRotation(
    laneId: string,
    accountUuid: string | null,
    refreshed: string,
    state: LaneAccountAuthState
  ): Promise<LaneRotationOutcome> {
    // The await above is a real network call, so the lane is re-resolved rather than trusted.
    const laneDir = this.options.store.resolveLaneDir(laneId)
    try {
      if (!laneDir) {
        throw new Error('lane directory is no longer owned by Orca')
      }
      await this.options.store.writer.writeCredentials(laneDir, refreshed)
    } catch (error) {
      // Loud, and never `refresh-failed`: the old token is revoked either way, so the watermark
      // moves to the rotated sha and the lane holds at reauth-required. Otherwise the desktop's
      // cached pre-rotation blob passes the freshness check and replays a revoked credential.
      console.warn(`[claude-lane] rotation could not reach lane ${laneId}:`, error)
      // The bytes may still have LANDED — this arm covers a partial publish as well as a lost
      // one. Attributing that write to us is what stops the next `syncLane` reading Orca's own
      // rotation as the lane CLI's, publishing a `cli-observed` receipt for it, and lifting the
      // hold this line is about to set.
      if (this.laneFileHolds(laneId, refreshed)) {
        state.lastWrittenCredentialsJson = refreshed
      }
      this.options.store.recordUnwritableRotation(laneId, refreshed)
      return { status: 'lane-write-lost', credentialsJson: refreshed }
    }
    state.lastWrittenCredentialsJson = refreshed
    state.lastSyncedAccountUuid = accountUuid
    state.hasMaterializedLaneAuth = true
    return { status: 'rotated', credentialsJson: refreshed }
  }

  /** Whether the lane file ended up holding this blob after all, however the write reported. */
  private laneFileHolds(laneId: string, credentialsJson: string): boolean {
    const onDisk = this.options.store.readLaneCredentials(laneId)
    return onDisk !== null && compareRefreshTokens(onDisk, credentialsJson) === 'same'
  }
}

export function laneAccountKey(laneId: string, accountUuid: string | null): string {
  return `${laneId}${LANE_ACCOUNT_KEY_SEPARATOR}${accountUuid ?? ''}`
}
