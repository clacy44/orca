import {
  ClaudeLaneRefusal,
  CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES
} from '../../shared/claude-lane-refusals'
import type { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import {
  listLaneAccounts,
  removeLaneAccount,
  selectLaneAccount
} from '../claude-accounts/principal-lane-account-store'
import type { LaneAccountRow } from '../../shared/claude-lane-login-rpc'
import type { LaneChangeCause, LaneWireCaller, LaneWirePrincipals } from './lane-wire-authority'

/**
 * The host side of `selectAccount` / `removeAccount` / `logout` (S9-L1 §modules D).
 *
 * `logout` is the caller's own lane, over `PrincipalLaneLifecycle.wipeOnExplicitLogout` — NOT the
 * ad hoc direct `wipeLaneCredentials` call the pre-S9-L1 `LaneWireAuthority.logout` made. Routing
 * through the lifecycle is the point: it marks wipe-pending, cancels every in-flight login session
 * of this lane in the SAME synchronous step (§fenceWiring), invalidates live usage probes and
 * sweeps the per-login account store, none of which the old direct call did.
 */
export type LaneAccountAuthorityOptions = {
  principals: LaneWirePrincipals
  coordinator: LaneCredentialCoordinator
  onLaneChanged?: (laneId: string, cause: LaneChangeCause) => void
}

export class LaneAccountAuthority {
  constructor(private readonly options: LaneAccountAuthorityOptions) {}

  /**
   * Synchronous over the lane's own store: `selectLaneAccount` enters the SAME per-lane write
   * queue a login capture and a wipe use, so a select queued behind either applies (or refuses
   * `account_unknown`) in queue order — never against a snapshot taken before either ran.
   */
  async selectAccount(
    pairedDeviceId: string | null | undefined,
    laneAccountId: string
  ): Promise<{ active: string }> {
    const caller = this.requireCaller(pairedDeviceId)
    const laneDir = this.requireProvisionedLaneDir(caller.principalId)
    await this.options.coordinator.authState.serializeLaneWrite(caller.principalId, () =>
      selectLaneAccount(laneDir, caller.principalId, laneAccountId, undefined, (id) =>
        this.options.coordinator.invalidateLaneUsageProbes(id)
      )
    )
    this.options.onLaneChanged?.(caller.principalId, 'select-account')
    return { active: laneAccountId }
  }

  async removeAccount(
    pairedDeviceId: string | null | undefined,
    laneAccountId: string
  ): Promise<{ removed: string }> {
    const caller = this.requireCaller(pairedDeviceId)
    const laneDir = this.requireProvisionedLaneDir(caller.principalId)
    await this.options.coordinator.authState.serializeLaneWrite(caller.principalId, () => {
      removeLaneAccount(laneDir, laneAccountId)
      return Promise.resolve()
    })
    this.options.onLaneChanged?.(caller.principalId, 'remove-account')
    return { removed: laneAccountId }
  }

  async logout(pairedDeviceId: string | null | undefined): Promise<{ cleared: string[] }> {
    const caller = this.requireCaller(pairedDeviceId)
    // Refuses `not_provisioned` before the fence runs, matching every other lane method's shape.
    this.requireProvisionedLaneDir(caller.principalId)
    // No `onLaneChanged` call here: the lifecycle's own `onLaneWiped` listener (wired by
    // `LaneWireService`) already republishes status on both the wipe's success AND give-up arms —
    // calling it again here would double-publish (unlike `selectAccount`/`removeAccount` below,
    // which do not go through the lifecycle and so own their own publish).
    const outcome = await this.options.coordinator.lifecycle.wipeOnExplicitLogout(
      caller.principalId
    )
    if (!outcome.completed) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.logout_incomplete',
        CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES['accounts.lane.logout_incomplete']
      )
    }
    return { cleared: outcome.removed }
  }

  /** Host-inline `orca lane use`: the CLI resolves `--person` itself, so this takes a
   * principalId directly rather than deriving one from a paired grant (§modules E). */
  async selectAccountInline(
    principalId: string,
    laneAccountId: string
  ): Promise<{ active: string }> {
    const laneDir = this.requireProvisionedLaneDir(principalId)
    await this.options.coordinator.authState.serializeLaneWrite(principalId, () =>
      selectLaneAccount(laneDir, principalId, laneAccountId, undefined, (id) =>
        this.options.coordinator.invalidateLaneUsageProbes(id)
      )
    )
    this.options.onLaneChanged?.(principalId, 'select-account')
    return { active: laneAccountId }
  }

  /** Host-inline `orca lane accounts` — a projection of the index, never a walk (§storeLayout).
   * Never `authDir`: a local filesystem path has no reason to cross the wire (mirrors the
   * `accounts` field `LaneWireAuthority.statusOf` publishes to a paired grant). */
  listAccountsInline(principalId: string): LaneAccountRow[] {
    const laneDir = this.requireProvisionedLaneDir(principalId)
    return listLaneAccounts(laneDir).map((account) => ({
      laneAccountId: account.laneAccountId,
      email: account.email,
      label: account.label,
      active: account.active
    }))
  }

  /** Host-inline `orca lane logout`. Same lifecycle-fence route as the grant-facing `logout`. */
  async logoutInline(principalId: string): Promise<{ cleared: string[] }> {
    this.requireProvisionedLaneDir(principalId)
    const outcome = await this.options.coordinator.lifecycle.wipeOnExplicitLogout(principalId)
    if (!outcome.completed) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.logout_incomplete',
        CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES['accounts.lane.logout_incomplete']
      )
    }
    return { cleared: outcome.removed }
  }

  private requireCaller(pairedDeviceId: string | null | undefined): LaneWireCaller {
    if (!pairedDeviceId) {
      throw unidentifiedCaller()
    }
    const principalId = this.options.principals.principalOf(pairedDeviceId)
    if (!principalId) {
      throw unidentifiedCaller()
    }
    return { deviceId: pairedDeviceId, principalId }
  }

  private requireProvisionedLaneDir(principalId: string): string {
    const laneDir = this.options.coordinator.store.resolveLaneDir(principalId)
    if (!laneDir) {
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
