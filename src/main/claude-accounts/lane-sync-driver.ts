import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import type { AccountResidencyIndex } from './account-residency-index'
import {
  compareRefreshTokens,
  readFreshnessFromCredentials,
  readIdentityFromOauthAccount,
  readRefreshTokenSha256
} from './claude-credential-identity'
import type { LaneAuthState } from './lane-auth-state'
import {
  resolveLaneIdentity,
  type LaneRotationCause,
  type PrincipalLaneStore
} from './principal-lane-store'

/**
 * `syncLane`, the per-lane analogue of `doSyncForCurrentSelection` (S9 §2c).
 *
 * A lane whose writer "does nothing else" never observes a rotation performed by the lane's own
 * live `claude`: the desktop's copy goes stale, the post-wipe reconnect re-push restores an
 * already-revoked blob, and every terminal in that lane then fails `invalid_grant`.
 */
export type LaneSyncTrigger =
  /** Before a lane-pinned launch — the lane arm of `prepareForClaudeLaunch`. */
  | 'launch'
  /** Each rate-limit tick for a lane with live PTYs, and each lane the usage pull probed. */
  | 'rate-limit-tick'
  /** Immediately before applying a push. */
  | 'pre-push'
  /** Once per lane at startup. OBSERVE-ONLY: see `isRotatingTrigger`. */
  | 'startup'

export type LaneSyncOutcome = {
  laneId: string
  trigger: LaneSyncTrigger
  laneState: RuntimeTerminalLaneState
  /** The lane's own CLI moved the token behind Orca's back. */
  observedForeignChange: boolean
  rotated: boolean
}

/**
 * Trigger 4 must not rotate.
 *
 * It runs BEFORE `seedLiveClaudePtysFromPersistence`, and `index.ts` states that ordering
 * invariant in so many words — a surviving daemon Claude CLI holds the single-use refresh token.
 * At that instant the lane-scoped liveness query is empty by construction, so a rotating startup
 * pass would hand the lane `invalid_grant` across every live session in it.
 */
export function isRotatingTrigger(trigger: LaneSyncTrigger): boolean {
  return trigger !== 'startup'
}

export type LaneSyncDriverOptions = {
  store: PrincipalLaneStore
  residency: AccountResidencyIndex
  authState: LaneAuthState
}

export class LaneSyncDriver {
  constructor(private readonly options: LaneSyncDriverOptions) {}

  /** Startup pass: one observe-only sync per lane, before the live-PTY gate is seeded. */
  async syncAllLanesAtStartup(laneIds: readonly string[]): Promise<LaneSyncOutcome[]> {
    const outcomes: LaneSyncOutcome[] = []
    for (const laneId of laneIds) {
      outcomes.push(await this.syncLane(laneId, 'startup'))
    }
    return outcomes
  }

  async syncLane(laneId: string, trigger: LaneSyncTrigger): Promise<LaneSyncOutcome> {
    return this.options.authState.serializeLaneWrite(laneId, () => this.doSyncLane(laneId, trigger))
  }

  private async doSyncLane(laneId: string, trigger: LaneSyncTrigger): Promise<LaneSyncOutcome> {
    const { store, residency, authState } = this.options
    const credentialsJson = store.readLaneCredentials(laneId)
    if (credentialsJson === null) {
      residency.clearLaneRow(laneId)
      return {
        laneId,
        trigger,
        laneState: store.getLaneState(laneId),
        observedForeignChange: false,
        rotated: false
      }
    }
    const oauthAccount = store.readLaneOauthAccount(laneId)
    residency.setLaneRow(laneId, credentialsJson, oauthAccount)
    const accountUuid = readIdentityFromOauthAccount(oauthAccount).accountUuid
    const observedForeignChange = this.observedForeignChange(laneId, accountUuid, credentialsJson)
    if (observedForeignChange) {
      // The lane's own CLI rotated: the receipt covers CLI-observed rotation, not only ours.
      this.publishReceipt(laneId, credentialsJson, oauthAccount, 'cli-observed')
    } else {
      store.recordSyncedLaneCredentials(laneId, credentialsJson, oauthAccount)
    }
    authState.getState(laneId, accountUuid).lastWrittenCredentialsJson = credentialsJson
    if (!isRotatingTrigger(trigger)) {
      return {
        laneId,
        trigger,
        laneState: store.getLaneState(laneId),
        observedForeignChange,
        rotated: false
      }
    }
    const rotated = await this.rotate(laneId, {
      accountUuid,
      credentialsJson,
      oauthAccount,
      observedForeignChange
    })
    return {
      laneId,
      trigger,
      laneState: store.getLaneState(laneId),
      observedForeignChange,
      rotated
    }
  }

  /**
   * Whether the lane file's refresh token has moved away from what Orca last wrote there.
   *
   * The in-memory last-written blob is the comparator's own input where there is one; across a
   * restart the secretless watermark's sha is the only witness left, so it is the fallback.
   */
  private observedForeignChange(
    laneId: string,
    accountUuid: string | null,
    credentialsJson: string
  ): boolean {
    const lastWritten = this.options.authState.getState(
      laneId,
      accountUuid
    ).lastWrittenCredentialsJson
    if (lastWritten !== null) {
      return compareRefreshTokens(credentialsJson, lastWritten) === 'different'
    }
    const watermarkSha = this.options.store.getWatermark(laneId)?.refreshTokenSha256 ?? null
    const fileSha = readRefreshTokenSha256(credentialsJson)
    return watermarkSha !== null && fileSha !== null && watermarkSha !== fileSha
  }

  private async rotate(
    laneId: string,
    input: {
      accountUuid: string | null
      credentialsJson: string
      oauthAccount: unknown
      observedForeignChange: boolean
    }
  ): Promise<boolean> {
    const outcome = await this.options.authState.rotateLaneCredentials({
      laneId,
      accountUuid: input.accountUuid,
      refreshTokenSha256: readRefreshTokenSha256(input.credentialsJson),
      credentialsJson: input.credentialsJson
    })
    if (outcome.status === 'rotated') {
      this.publishReceipt(laneId, outcome.credentialsJson, input.oauthAccount, 'host')
      this.options.residency.setLaneRow(laneId, outcome.credentialsJson, input.oauthAccount)
      return true
    }
    // A refresh that fails on a token something else already moved is not transient: that copy
    // is spent, and only a fresh login recovers the lane.
    if (outcome.status === 'refresh-failed' && input.observedForeignChange) {
      this.publishReceipt(laneId, input.credentialsJson, input.oauthAccount, 'foreign-rotation')
    }
    return false
  }

  private publishReceipt(
    laneId: string,
    credentialsJson: string,
    oauthAccount: unknown,
    cause: LaneRotationCause
  ): void {
    this.options.store.recordRotationReceipt({
      laneId,
      identity: resolveLaneIdentity(credentialsJson, oauthAccount),
      refreshTokenSha256: readRefreshTokenSha256(credentialsJson),
      expiresAt: readFreshnessFromCredentials(credentialsJson),
      cause
    })
  }
}
