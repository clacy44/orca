import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeCredentialIdentity } from '../../shared/claude-credential-identity-types'
import type { ClaudeLaneStatus } from '../../shared/claude-lane-delegation'
import {
  readIdentityFromOauthAccount,
  readRefreshTokenSha256
} from '../claude-accounts/claude-credential-identity'
import type { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { parseLanePushRequest, type LanePushRequest } from '../claude-accounts/lane-push-envelope'
import { wipeLaneCredentials } from '../claude-accounts/principal-lane-credential-sweep'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from '../claude-accounts/live-pty-gate'
import type { LaneDelegationDirectory } from './lane-delegation-directory'

/**
 * The host side of the lane wire: push, pull, clear and status (S9 §2b/§2c/§2d/§2e).
 *
 * The lane is derived from `pairedDeviceId → principalId` and from nothing else. There is no lane
 * parameter on any method here, so there is nothing for a caller to spoof, and every refusal is
 * conditioned on the CALLER'S own lane state rather than on "some lane exists on this host".
 */

export type LaneWirePrincipals = {
  principalOf(deviceId: string): string | null
  delegatedGrantIdOf(principalId: string): string | null
  /** The presence label a refusal names as the remedy's address; never a device name. */
  labelOf?(principalId: string): string | null
  /** §2d's PEER rows only. Absent = the caller still gets their own lane row, from `resolveCaller`. */
  listPrincipals?(): readonly { principalId: string; label: string | null }[]
}

/** The lane's switch gate: `begin/endClaudeAuthSwitch`, keyed by the lane being written. */
export type LaneSwitchGate = {
  begin(laneId: string): void
  end(laneId: string): void
}

export type LaneWireCaller = { deviceId: string; principalId: string }

/** A push ANSWERS an outstanding switch request; a clear leaves it unanswered (§2l). */
export type LaneChangeCause = 'push' | 'clear'

export type LaneWireAuthorityOptions = {
  principals: LaneWirePrincipals
  coordinator: LaneCredentialCoordinator
  delegation: LaneDelegationDirectory
  switchGate?: LaneSwitchGate
  platform?: NodeJS.Platform
  onLaneChanged?: (laneId: string, cause: LaneChangeCause) => void
}

export type LanePushResult = {
  laneState: ClaudeLaneStatus['laneState']
  refreshTokenSha256: string | null
  expiresAt: number | null
}

export type LanePullRotatedResult =
  | { rotated: false }
  | {
      rotated: true
      credentialsJson: string
      oauthAccountJson: string | null
      refreshTokenSha256: string | null
    }

const LANE_SWITCH_GATE: LaneSwitchGate = {
  begin: (laneId) => beginClaudeAuthSwitch(laneId),
  end: (laneId) => endClaudeAuthSwitch(laneId)
}

export class LaneWireAuthority {
  constructor(private readonly options: LaneWireAuthorityOptions) {}

  /** `pairedDeviceId → principal`, the only derivation any lane method performs. */
  resolveCaller(pairedDeviceId: string | null | undefined): LaneWireCaller | null {
    if (!pairedDeviceId) {
      return null
    }
    const principalId = this.options.principals.principalOf(pairedDeviceId)
    return principalId ? { deviceId: pairedDeviceId, principalId } : null
  }

  requireCaller(pairedDeviceId: string | null | undefined): LaneWireCaller {
    const caller = this.resolveCaller(pairedDeviceId)
    if (!caller) {
      throw unidentifiedCaller()
    }
    return caller
  }

  /**
   * §2b/§2c's push, in the order the two sections fix.
   *
   * Authorization first — designation, then the lease, then provisioning — because an
   * unauthorized caller's blob must not even be parsed; then validate, then the pre-push sync
   * (trigger 3), then residency → freshness → write → watermark under the lane's write queue and
   * its switch gate. The sync CANNOT run inside the queue: it takes the same queue itself.
   */
  async push(pairedDeviceId: string | null | undefined, params: unknown): Promise<LanePushResult> {
    const caller = this.requireCallerForPush(pairedDeviceId)
    this.assertDelegatedPusher(caller)
    const laneDir = this.requireProvisionedLaneDir(caller.principalId)
    const request = parseLanePushRequest(params)
    await this.options.coordinator.syncLane(caller.principalId, 'pre-push')
    return this.options.coordinator.authState.serializeLaneWrite(caller.principalId, () =>
      this.applyPush(caller.principalId, laneDir, request)
    )
  }

  /** Q2: the desktop pulls a rotation back. Nothing is returned when its sha already matches. */
  pullRotated(
    pairedDeviceId: string | null | undefined,
    knownRefreshTokenSha256: string | null
  ): LanePullRotatedResult {
    const caller = this.requireCaller(pairedDeviceId)
    this.assertDelegatedPusher(caller)
    const { store } = this.options.coordinator
    const credentialsJson = store.readLaneCredentials(caller.principalId)
    if (!credentialsJson) {
      return { rotated: false }
    }
    const sha = readRefreshTokenSha256(credentialsJson)
    if (sha !== null && sha === knownRefreshTokenSha256) {
      return { rotated: false }
    }
    const oauthAccount = store.readLaneOauthAccount(caller.principalId)
    return {
      rotated: true,
      credentialsJson,
      oauthAccountJson: oauthAccount ? JSON.stringify(oauthAccount) : null,
      refreshTokenSha256: sha
    }
  }

  /**
   * §2f's wipe, addressed to the caller's OWN lane: files, identity and residency row.
   *
   * The watermark is kept on purpose — a re-push after a clear is still judged against what the
   * lane last held, which is what refuses a replay of a blob the lane's CLI has since rotated. The
   * released delegation therefore rides its own published flag, not the absence of either.
   */
  async clear(pairedDeviceId: string | null | undefined): Promise<{ cleared: string[] }> {
    const caller = this.requireCaller(pairedDeviceId)
    const laneDir = this.requireProvisionedLaneDir(caller.principalId)
    const cleared = await this.options.coordinator.authState.serializeLaneWrite(
      caller.principalId,
      async () => {
        const gate = await this.beginLaneSwitch(caller.principalId)
        try {
          const removed = await wipeLaneCredentials(laneDir, { platform: this.options.platform })
          this.options.coordinator.residency.clearLaneRow(caller.principalId)
          this.options.delegation.markLaneCleared(caller.principalId)
          return removed
        } finally {
          gate.end(caller.principalId)
        }
      }
    )
    this.options.onLaneChanged?.(caller.principalId, 'clear')
    return { cleared }
  }

  /** The status one grant may read: its own principal's lane, and no other. */
  status(pairedDeviceId: string | null | undefined): ClaudeLaneStatus {
    const caller = this.requireCaller(pairedDeviceId)
    return this.statusOf(caller)
  }

  statusOf(caller: LaneWireCaller): ClaudeLaneStatus {
    const { store } = this.options.coordinator
    const watermark = store.getWatermark(caller.principalId)
    const delegatedGrantId = this.options.principals.delegatedGrantIdOf(caller.principalId)
    const row = this.options.delegation.getRow(caller.principalId)
    return {
      laneId: caller.principalId,
      laneState: store.getLaneState(caller.principalId),
      delegatedGrantId,
      callerIsDelegatedGrant: delegatedGrantId === caller.deviceId,
      delegationCleared: row.delegationCleared === true,
      heldDisplayName: row.heldDisplayName,
      heldDelegatedAccountId: row.heldDelegatedAccountId ?? null,
      heldIdentity: watermark?.identity ?? null,
      refreshTokenSha256: watermark?.refreshTokenSha256 ?? null,
      expiresAt: watermark?.expiresAt ?? null,
      delegable: row.delegable
    }
  }

  /** §2e: a push is refused unless the caller's grant IS the principal's designated pusher. */
  assertDelegatedPusher(caller: LaneWireCaller): void {
    const delegatedGrantId = this.options.principals.delegatedGrantIdOf(caller.principalId)
    if (!delegatedGrantId) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.no_pusher_designated',
        "Nobody is designated to load Claude accounts into this person's lane on this host, so the lane cannot be loaded. Pick which of their devices pushes accounts, in Orca on the host machine."
      )
    }
    if (delegatedGrantId !== caller.deviceId) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.push_not_delegated',
        'This device is not the one designated to load Claude accounts into this lane, so its account was not written. Push from the designated device, or change the designation in Orca on the host machine.'
      )
    }
  }

  requireProvisionedLaneDir(principalId: string): string {
    const laneDir = this.options.coordinator.store.resolveLaneDir(principalId)
    if (!laneDir) {
      // Never auto-provision: a lane exists only because the local human made one (§2a).
      throw new ClaudeLaneRefusal(
        'accounts.lane.not_provisioned',
        'This person has no Claude credential lane on this host, so there is nowhere to load their account. Create the lane in Orca on the host machine first.'
      )
    }
    return laneDir
  }

  private requireCallerForPush(pairedDeviceId: string | null | undefined): LaneWireCaller {
    const caller = this.resolveCaller(pairedDeviceId)
    if (caller) {
      return caller
    }
    if (!pairedDeviceId) {
      throw unidentifiedCaller()
    }
    // A grant bound to no principal is no principal's designated pusher, which is the accurate
    // refusal and the one §5's principal-binding arm names for this exact caller.
    throw new ClaudeLaneRefusal(
      'accounts.lane.push_not_delegated',
      "This device is not linked to a person on this host, so it cannot load a Claude account into anyone's lane. Link it in Orca on the host machine first."
    )
  }

  /**
   * Closes the lane's switch gate and then kills what the change is about to invalidate (§2k).
   *
   * Order is the fence: the gate stops the NEXT probe from starting, the invalidation ends the one
   * already running — which is holding the pre-change single-use refresh token and would otherwise
   * post usage for the old account and rotate a credential the lane no longer holds.
   */
  private async beginLaneSwitch(laneId: string): Promise<LaneSwitchGate> {
    const gate = this.options.switchGate ?? LANE_SWITCH_GATE
    gate.begin(laneId)
    await this.options.coordinator.invalidateLaneUsageProbes(laneId)
    return gate
  }

  private async applyPush(
    laneId: string,
    laneDir: string,
    request: LanePushRequest
  ): Promise<LanePushResult> {
    const { coordinator } = this.options
    const identity: ClaudeCredentialIdentity = readIdentityFromOauthAccount(request.oauthAccount)
    coordinator.residency.assertAccountNotResidentElsewhere(
      {
        accountId: identity.accountUuid ?? laneId,
        accountUuid: identity.accountUuid,
        refreshTokenSha256: readRefreshTokenSha256(request.envelope.credentialsJson)
      },
      laneId
    )
    coordinator.store.assertPushIsFresh({
      laneId,
      credentialsJson: request.envelope.credentialsJson,
      basedOnRefreshTokenSha256: request.basedOnRefreshTokenSha256,
      oauthAccount: request.oauthAccount,
      reauthenticated: request.reauthenticated
    })
    const gate = await this.beginLaneSwitch(laneId)
    try {
      await coordinator.store.writer.writeCredentials(laneDir, request.envelope.credentialsJson)
      coordinator.store.writer.writeOauthAccount(laneDir, request.oauthAccount)
    } finally {
      gate.end(laneId)
    }
    const watermark = coordinator.store.recordPushedLaneCredentials(
      laneId,
      request.envelope.credentialsJson,
      request.oauthAccount
    )
    coordinator.residency.setLaneRow(laneId, request.envelope.credentialsJson, request.oauthAccount)
    this.options.delegation.setHeldAccount(laneId, {
      displayName: request.envelope.displayName,
      email: identity.email
    })
    this.options.onLaneChanged?.(laneId, 'push')
    return {
      laneState: coordinator.store.getLaneState(laneId),
      refreshTokenSha256: watermark.refreshTokenSha256,
      expiresAt: watermark.expiresAt
    }
  }
}

function unidentifiedCaller(): ClaudeLaneRefusal {
  return new ClaudeLaneRefusal(
    'accounts.lane.caller_unidentified',
    'Orca could not tell which person this request came from, so it addressed no Claude credential lane. Run this from a device that is paired with this host and linked to a person.'
  )
}
