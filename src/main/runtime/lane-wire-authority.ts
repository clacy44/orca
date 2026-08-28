import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeLaneStatus } from '../../shared/claude-lane-delegation'
import type { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { wipeLaneCredentials } from '../claude-accounts/principal-lane-credential-sweep'
import { isLaneWipeInFlight } from '../claude-accounts/lane-wipe-pending'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from '../claude-accounts/live-pty-gate'

/**
 * The host side of the lane wire: status and logout (S9 §2c/§2d, rev 32's credential-source
 * re-basing).
 *
 * The lane is derived from `pairedDeviceId → principalId` and from nothing else. There is no lane
 * parameter on any method here, so there is nothing for a caller to spoof, and every refusal is
 * conditioned on the CALLER'S own lane state rather than on "some lane exists on this host".
 *
 * Rev 32 deletes `push`, `pullRotated` and the delegation directory (delegable list,
 * `setDelegableAccounts`) with the push model (§10(g)); S9-L1's `selectAccount`/`removeAccount`
 * and login-quartet RPCs are not yet wired into this tree's host — `logout` below is `clear`
 * renamed to the verb §3 row 2 specifies, over the same wipe mechanism.
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

export type LaneChangeCause = 'logout' | 'wipe'

export type LaneWireAuthorityOptions = {
  principals: LaneWirePrincipals
  coordinator: LaneCredentialCoordinator
  switchGate?: LaneSwitchGate
  platform?: NodeJS.Platform
  onLaneChanged?: (laneId: string, cause: LaneChangeCause) => void
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
   * §2f's wipe, addressed to the caller's OWN lane, over `accounts.lane.logout` (rev 32 renames
   * `clear` to `logout`; the per-login-directory sweep §3 row 2 also specifies is S9-L1's, not yet
   * in this tree — this wipes the lane's `.credentials.json`/`oauthAccount`, same as before).
   */
  async logout(pairedDeviceId: string | null | undefined): Promise<{ cleared: string[] }> {
    const caller = this.requireCaller(pairedDeviceId)
    const laneDir = this.requireProvisionedLaneDir(caller.principalId)
    const cleared = await this.options.coordinator.authState.serializeLaneWrite(
      caller.principalId,
      async () => {
        const gate = await this.beginLaneSwitch(caller.principalId)
        try {
          return await wipeLaneCredentials(laneDir, { platform: this.options.platform })
        } finally {
          gate.end(caller.principalId)
        }
      }
    )
    this.options.onLaneChanged?.(caller.principalId, 'logout')
    return { cleared }
  }

  /** The status one grant may read: its own principal's lane, and no other. */
  status(pairedDeviceId: string | null | undefined): ClaudeLaneStatus {
    const caller = this.requireCaller(pairedDeviceId)
    return this.statusOf(caller)
  }

  statusOf(caller: LaneWireCaller): ClaudeLaneStatus {
    const { store } = this.options.coordinator
    const credentialState = store.getCredentialState(caller.principalId)
    const delegatedGrantId = this.options.principals.delegatedGrantIdOf(caller.principalId)
    return {
      laneId: caller.principalId,
      laneState: store.getLaneState(caller.principalId),
      delegatedGrantId,
      callerIsDelegatedGrant: delegatedGrantId === caller.deviceId,
      heldDisplayName: null,
      heldIdentity: credentialState?.identity ?? null,
      refreshTokenSha256: credentialState?.refreshTokenSha256 ?? null,
      expiresAt: credentialState?.expiresAt ?? null
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

  /**
   * Closes the lane's switch gate and then kills what the change is about to invalidate (§2k).
   *
   * Order is the fence: the gate stops the NEXT probe from starting, the invalidation ends the one
   * already running — which is holding the pre-change single-use refresh token and would otherwise
   * post usage for the old account and rotate a credential the lane no longer holds.
   */
  private async beginLaneSwitch(laneId: string): Promise<LaneSwitchGate> {
    const gate = this.options.switchGate ?? LANE_SWITCH_GATE
    if (isLaneWipeInFlight(laneId)) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.wipe_in_progress',
        'Orca is clearing this credential lane on the host right now, so it did not run a second wipe. Wait for that to finish, then try again.'
      )
    }
    gate.begin(laneId)
    try {
      await this.options.coordinator.invalidateLaneUsageProbes(laneId)
    } catch (error) {
      // The caller's `finally { gate.end(…) }` is not entered yet, and `begin` throws on a lane
      // that is already gated — so a rejection here would leave this lane refusing every spawn and
      // every logout for the process lifetime rather than for this logout.
      gate.end(laneId)
      throw error
    }
    return gate
  }
}

function unidentifiedCaller(): ClaudeLaneRefusal {
  return new ClaudeLaneRefusal(
    'accounts.lane.caller_unidentified',
    'Orca could not tell which person this request came from, so it addressed no Claude credential lane. Run this from a device that is paired with this host and linked to a person.'
  )
}
