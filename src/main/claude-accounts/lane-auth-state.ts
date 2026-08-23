import type { AccountResidencyIndex } from './account-residency-index'
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

  /** One queue per lane: lane A's slow write does not delay lane B's. */
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
      const refresh = this.options.refreshCredentials ?? refreshClaudeOauthCredentials
      const refreshed = await refresh(input.credentialsJson)
      if (!refreshed || !hasClaudeOauthAccessToken(refreshed)) {
        return { status: 'refresh-failed' }
      }
      const laneDir = this.options.store.resolveLaneDir(input.laneId)
      if (!laneDir) {
        return { status: 'refresh-failed' }
      }
      this.options.store.writer.writeCredentials(laneDir, refreshed)
      state.lastWrittenCredentialsJson = refreshed
      state.lastSyncedAccountUuid = input.accountUuid
      state.hasMaterializedLaneAuth = true
      return { status: 'rotated', credentialsJson: refreshed }
    })
  }
}

export function laneAccountKey(laneId: string, accountUuid: string | null): string {
  return `${laneId}${LANE_ACCOUNT_KEY_SEPARATOR}${accountUuid ?? ''}`
}
