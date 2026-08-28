import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeLaneStatus } from '../../shared/claude-lane-delegation'
import type { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { listLaneAccounts } from '../claude-accounts/principal-lane-account-store'
import { isLaneWipePending } from '../claude-accounts/lane-wipe-pending'

/**
 * The host side of the lane wire: caller derivation and status (S9 §2c/§2d, rev 32's
 * credential-source re-basing).
 *
 * The lane is derived from `pairedDeviceId → principalId` and from nothing else. There is no lane
 * parameter on any method here, so there is nothing for a caller to spoof, and every refusal is
 * conditioned on the CALLER'S own lane state rather than on "some lane exists on this host".
 *
 * Rev 32 deletes `push`, `pullRotated` and the delegation directory (delegable list,
 * `setDelegableAccounts`) with the push model (§10(g)). S9-L1 moves `logout` (formerly `clear`,
 * renamed at §3 row 2) to `lane-account-authority.ts`, alongside the new `selectAccount`/
 * `removeAccount` — routed through `PrincipalLaneLifecycle.wipeOnExplicitLogout` there rather than
 * the direct `wipeLaneCredentials` call this class used to make, so a logout gets the same
 * login-session-cancelling fence every other wipe reason gets (§fenceWiring). The other lane
 * authority classes each keep their own small `requireCaller`/`requireProvisionedLaneDir` — the
 * derivation is five lines and duplicating it avoids threading this class through every other one
 * just to reach two methods.
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

export type LaneChangeCause = 'logout' | 'wipe' | 'select-account' | 'remove-account'

export type LaneWireAuthorityOptions = {
  principals: LaneWirePrincipals
  coordinator: LaneCredentialCoordinator
  switchGate?: LaneSwitchGate
  platform?: NodeJS.Platform
  onLaneChanged?: (laneId: string, cause: LaneChangeCause) => void
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

  /** The status one grant may read: its own principal's lane, and no other. */
  status(pairedDeviceId: string | null | undefined): ClaudeLaneStatus {
    const caller = this.requireCaller(pairedDeviceId)
    return this.statusOf(caller)
  }

  statusOf(caller: LaneWireCaller): ClaudeLaneStatus {
    const { store } = this.options.coordinator
    const credentialState = store.getCredentialState(caller.principalId)
    const delegatedGrantId = this.options.principals.delegatedGrantIdOf(caller.principalId)
    const laneDir = store.resolveLaneDir(caller.principalId)
    return {
      laneId: caller.principalId,
      laneState: store.getLaneState(caller.principalId),
      // §fenceWiring "laneWipePending PUBLISH": additive and, until now, never actually populated
      // here — an old client already tolerates its absence and reads `laneState` alone.
      laneWipePending: isLaneWipePending(caller.principalId),
      delegatedGrantId,
      callerIsDelegatedGrant: delegatedGrantId === caller.deviceId,
      heldDisplayName: null,
      heldIdentity: credentialState?.identity ?? null,
      refreshTokenSha256: credentialState?.refreshTokenSha256 ?? null,
      expiresAt: credentialState?.expiresAt ?? null,
      // §rpcs item 8: an unprovisioned lane has no store to project — `[]`, never a walk.
      accounts: laneDir
        ? listLaneAccounts(laneDir).map((account) => ({
            laneAccountId: account.laneAccountId,
            email: account.email,
            label: account.label,
            active: account.active
          }))
        : []
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
}

function unidentifiedCaller(): ClaudeLaneRefusal {
  return new ClaudeLaneRefusal(
    'accounts.lane.caller_unidentified',
    'Orca could not tell which person this request came from, so it addressed no Claude credential lane. Run this from a device that is paired with this host and linked to a person.'
  )
}
