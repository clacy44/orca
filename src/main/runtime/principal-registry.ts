import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { isPrincipalId } from '../claude-accounts/principal-credential-lane'
import type { HostConsent } from './principal-consent-authority'
import {
  isLinkBindingStillValid,
  resolveBindableLinkGrant,
  type LinkBindableGrant
} from './principal-link-fingerprint-binding'
import {
  inviteMintedAuditRow,
  loadPrincipalRegistryState,
  PRINCIPAL_AUDIT_MAX_ROWS,
  PRINCIPAL_REGISTRY_FILENAME,
  savePrincipalRegistryState,
  validatePrincipalDisplayName,
  type PrincipalAuditRow,
  type PrincipalPlatformAcceptance,
  type PrincipalRecord,
  type PrincipalRegistryState
} from './principal-registry-store'
import { isMintedPendingDevice } from './device-registry-pending-grants'

import type {
  LaneGrantSummary,
  PrincipalGrantRow,
  PrincipalGrantSource,
  PrincipalRegistryOptions
} from './principal-grant-source'

export type { LaneGrantSummary, PrincipalGrantRow, PrincipalGrantSource, PrincipalRegistryOptions }

type MintInviteArgs = { deviceId: string; principalId: string; scope: 'mobile' | 'runtime' }
type MintInviteResult = { expiresAt: number }

/**
 * Principals, and the five host-side consent writes that are their only writers (S9 §2a).
 *
 * A `HostConsent` is required by every mutator and is constructible only by
 * `principal-consent-authority.ts`, so "no client can cause it" is a property of the types rather
 * than of a check one caller might forget. Nothing here inspects device kind: no signal in this
 * tree carries one — `scope` is the invite's own label with no desktop value, and client
 * capabilities are copied out of the client's handshake — so the human at the machine is the
 * authority, full stop.
 */
export class PrincipalRegistry {
  private readonly registryPath: string
  private state: PrincipalRegistryState
  private readonly stateLoadSucceeded: boolean
  private readonly now: () => number

  constructor(
    userDataPath: string,
    private readonly grants: PrincipalGrantSource,
    private readonly options: PrincipalRegistryOptions = {}
  ) {
    this.registryPath = join(userDataPath, PRINCIPAL_REGISTRY_FILENAME)
    this.now = options.now ?? Date.now
    const loaded = loadPrincipalRegistryState(this.registryPath)
    this.state = loaded.state
    this.stateLoadSucceeded = loaded.loadSucceeded
  }

  get loadSucceeded(): boolean {
    return this.stateLoadSucceeded && this.grants.loadSucceeded
  }

  listPrincipals(): readonly PrincipalRecord[] {
    return this.state.principals
  }

  listAudit(): readonly PrincipalAuditRow[] {
    return this.state.audit
  }

  createPrincipal(_consent: HostConsent, displayName: string): PrincipalRecord {
    const principal: PrincipalRecord = {
      principalId: randomUUID(),
      displayName: validatePrincipalDisplayName(displayName),
      createdAt: this.now()
    }
    // Why: validated at creation, so no principal id ever reaches path.join unvalidated.
    if (!isPrincipalId(principal.principalId)) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.principal_id_invalid',
        'Orca could not mint a principal id in the shape a credential lane requires. Try again; if it keeps happening, restart Orca on the host.'
      )
    }
    this.commit(
      { ...this.state, principals: [...this.state.principals, principal] },
      { action: 'create-principal', principalId: principal.principalId }
    )
    return principal
  }

  /** The principal a grant is bound to, or null — the lane-less grant of rev 10, byte-for-byte. */
  principalOf(deviceId: string): string | null {
    const binding = this.state.bindings.find((row) => row.deviceId === deviceId)
    if (!binding || !this.grants.getDevice(deviceId)) {
      return null
    }
    return this.state.principals.some((row) => row.principalId === binding.principalId)
      ? binding.principalId
      : null
  }

  /**
   * Every pairing grant this host still knows, joined with its lane binding (S9 §2a read side).
   *
   * The host-only surface's one grant roster: bind offers an unbound `perPerson` row a device to
   * name, and status/audit render `boundPrincipalId` and `designated`. A revoked device drops out
   * with `listDevices`, so a stale row never reaches the surface as a live one.
   */
  listGrants(): LaneGrantSummary[] {
    return this.grants.listDevices().map((device) => {
      const boundPrincipalId = this.principalOf(device.deviceId)
      return {
        deviceId: device.deviceId,
        label: device.name,
        perPerson: device.pendingExpiresAt !== undefined,
        boundPrincipalId,
        designated:
          boundPrincipalId !== null &&
          this.delegatedGrantIdOf(boundPrincipalId) === device.deviceId,
        // M1: an un-redeemed per-person invite (§9 step 0.2's checkable precondition).
        redeemed: device.lastSeenAt > 0
      }
    })
  }

  /** Bound grants whose device row still survives — a revoke stops counting immediately. */
  boundDeviceIds(principalId: string): string[] {
    return this.state.bindings
      .filter((row) => row.principalId === principalId && this.grants.getDevice(row.deviceId))
      .map((row) => row.deviceId)
  }

  /** Principals still claimed by a surviving grant; the orphan lane sweep's input. */
  boundPrincipalIds(): string[] {
    const ids = this.state.principals.map((p) => p.principalId)
    return Array.from(new Set(ids.filter((id) => this.boundDeviceIds(id).length > 0)))
  }

  bindGrant(_consent: HostConsent, deviceId: string, principalId: string): void {
    this.assertBindable(deviceId, principalId)
    if (this.principalOf(deviceId)) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.grant_already_bound',
        'That device is already bound to a person. Unbind it first — re-binding is unbind-then-bind, never a rewrite in place.'
      )
    }
    this.commit(
      {
        ...this.state,
        bindings: [
          ...this.state.bindings.filter((row) => row.deviceId !== deviceId),
          { deviceId, principalId, boundAt: this.now() }
        ]
      },
      { action: 'bind', principalId, deviceId, direction: 'bind' }
    )
  }

  unbindGrant(consent: HostConsent, deviceId: string): boolean {
    const binding = this.state.bindings.find((row) => row.deviceId === deviceId)
    if (!binding) {
      return false
    }
    this.commit(
      {
        ...this.state,
        bindings: this.state.bindings.filter((row) => row.deviceId !== deviceId)
      },
      { action: 'unbind', principalId: binding.principalId, deviceId, direction: 'unbind' }
    )
    // Why: `delegatedGrantId` names a BOUND grant and cannot outlive the binding it names; the
    // principal drops to no designation and the next push is refused rather than served stale.
    this.clearDesignationNaming(consent, deviceId)
    return true
  }

  rebindGrant(consent: HostConsent, deviceId: string, principalId: string): void {
    // Why the target is validated BEFORE the unbind leg: unbinding commits the removal and clears
    // the designation with it, so a re-bind refused on its second leg would leave a working grant
    // unbound and its principal unpushable. A refused re-bind changes nothing.
    //
    // A SUCCESSFUL re-bind, including one back to the same principal, still drops the designation
    // with the unbind leg — §2a's "never a rewrite in place". The principal is left unpushable
    // until a human re-ticks, which fails closed; S9d's surface must re-prompt for it.
    this.assertBindable(deviceId, principalId)
    this.unbindGrant(consent, deviceId)
    this.bindGrant(consent, deviceId, principalId)
  }

  /** Everything a bind requires of its target and its row, minus the already-bound check. */
  private assertBindable(deviceId: string, principalId: string): void {
    this.requirePrincipal(principalId)
    const device = this.grants.getDevice(deviceId)
    if (!device) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.grant_unknown',
        'That device is no longer paired with this host, so it cannot be bound to a person. Pair it again and bind the new invite.'
      )
    }
    // Why: the ordinary regenerate-QR link COALESCES, so two humans can land on one row and one
    // token. `pendingExpiresAt` is the durable per-person discriminator, written at mint.
    if (device.pendingExpiresAt === undefined) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.grant_not_per_person',
        'That pairing was made with a shared invite link, so Orca cannot tell whether it belongs to one person or several. Re-pair the device with its own named invite before binding it to someone.'
      )
    }
    this.assertGrantRedeemed(device)
    // Why no deadline check here: §2a rule (i) constrains the surface that offers a bind, not the
    // row's own clock — `device-registry-pending-grants.ts` prunes an expired unscanned row at load.
  }

  /**
   * Designates which of a principal's already-bound grants may push into its lane.
   *
   * Offered at ANY time over the principal's own bound grants, connected or not, and filtered on
   * nothing else: a mis-designation is inert (no push ever arrives, the lane stays absent) and is
   * recovered by one re-tick, so no eligibility predicate is claimed here (§2a rev 19).
   */
  designatePusher(consent: HostConsent, principalId: string, deviceId: string): void {
    this.requirePrincipal(principalId)
    if (!this.boundDeviceIds(principalId).includes(deviceId)) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.grant_not_bound',
        'Only a device already bound to this person can be designated as the one that pushes their Claude account. Bind it to them first.'
      )
    }
    // Re-checked independently of bind (M1): a row bound by an older build can already be unredeemed.
    this.assertGrantRedeemed(this.grants.getDevice(deviceId))
    this.writeDesignation(consent, principalId, deviceId)
  }

  /** The provisioning audit write (B2): a `provision` row, carrying the §6 override when used. */
  recordLaneProvisioned(
    _consent: HostConsent,
    principalId: string,
    platformAcceptance?: PrincipalPlatformAcceptance
  ): void {
    const platformRow = platformAcceptance ? { platformAcceptance } : {}
    this.commit(this.state, { action: 'provision', principalId, ...platformRow })
  }

  /** `mint-invite` audit write (`orca lane invite`): never a token, never a pairing URL. */
  recordInviteMinted(_consent: HostConsent, args: MintInviteArgs): MintInviteResult {
    const expiresAt = this.grants.getDevice(args.deviceId)?.pendingExpiresAt ?? this.now()
    this.commit(this.state, inviteMintedAuditRow(args.deviceId, args, expiresAt))
    return { expiresAt }
  }

  delegatedGrantIdOf(principalId: string): string | null {
    const designated = this.state.principals.find(
      (row) => row.principalId === principalId
    )?.delegatedGrantId
    // Why: a designation whose grant was revoked out from under it is no designation at all.
    return designated && this.boundDeviceIds(principalId).includes(designated) ? designated : null
  }

  /**
   * The provisioning gate: bound grants, and a designated device among them (rev 32, §2d(i)).
   *
   * A lane is never created without a designation — the one grant that may start a login for it.
   */
  assertLaneProvisionable(principalId: string): void {
    this.requirePrincipal(principalId)
    if (this.boundDeviceIds(principalId).length === 0) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.grant_not_bound',
        'No device is bound to this person yet, so there is nothing to give a credential lane to. Bind one of their devices first.'
      )
    }
    if (!this.delegatedGrantIdOf(principalId)) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.no_login_device_designated',
        'No device is designated to sign this lane into a Claude account, so Orca cannot create their credential lane. Tick one of their bound devices as the one that signs them in.'
      )
    }
  }

  /** The fifth consent write: this link may create in its grant's principal's lane at all. */
  bindFederatedLink(_consent: HostConsent, homePeerFingerprint: string): LinkBindableGrant {
    const grant = resolveBindableLinkGrant(homePeerFingerprint, {
      runtimeAuthToken: this.options.runtimeAuthToken ?? null,
      grants: this.grants.listDevices()
    })
    this.commit(
      {
        ...this.state,
        linkBindings: [
          ...this.state.linkBindings.filter(
            (row) => row.homePeerFingerprint !== homePeerFingerprint
          ),
          { homePeerFingerprint, boundDeviceId: grant.deviceId, boundAt: this.now() }
        ]
      },
      {
        action: 'link-bind',
        principalId: this.principalOf(grant.deviceId),
        deviceId: grant.deviceId,
        homePeerFingerprint
      }
    )
    return grant
  }

  /** The principal a federated create runs as, or null → `terminal.lane_link_unbound` at the site. */
  linkPrincipalOf(homePeerFingerprint: string): string | null {
    const binding = this.state.linkBindings.find(
      (row) => row.homePeerFingerprint === homePeerFingerprint
    )
    if (!binding) {
      return null
    }
    const grant = this.grants.getDevice(binding.boundDeviceId)
    if (!isLinkBindingStillValid(homePeerFingerprint, grant)) {
      return null
    }
    return this.principalOf(binding.boundDeviceId)
  }

  private clearDesignationNaming(consent: HostConsent, deviceId: string): void {
    const principal = this.state.principals.find((row) => row.delegatedGrantId === deviceId)
    if (principal) {
      this.writeDesignation(consent, principal.principalId, null)
    }
  }

  private writeDesignation(
    _consent: HostConsent,
    principalId: string,
    deviceId: string | null
  ): void {
    this.commit(
      {
        ...this.state,
        principals: this.state.principals.map((row) => {
          if (row.principalId !== principalId) {
            return row
          }
          return deviceId ? { ...row, delegatedGrantId: deviceId } : stripDelegatedGrantId(row)
        })
      },
      { action: 'designate', principalId, designatedGrantId: deviceId }
    )
  }

  private requirePrincipal(principalId: string): PrincipalRecord {
    const principal = this.state.principals.find((row) => row.principalId === principalId)
    if (!principal) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.principal_unknown',
        'Orca has no record of that person. Create them at the pairing consent step, then bind the device to them.'
      )
    }
    return principal
  }

  /** M1: refuses a bind/designation naming an invite nobody redeemed \u2014 else whoever redeems it later inherits the binding. */
  private assertGrantRedeemed(device: PrincipalGrantRow | null): void {
    if (device && isMintedPendingDevice(device)) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.grant_not_redeemed',
        'That invite has not been redeemed yet, so Orca cannot tell which device \u2014 or which person \u2014 will end up holding it, and it was not linked to anyone. Open the invite on the device first, then link it here.'
      )
    }
  }

  private commit(nextState: PrincipalRegistryState, row: Omit<PrincipalAuditRow, 'at'>): void {
    // Why capped here and not only in the store: an in-memory trail that outgrew the file would
    // make `listAudit()` disagree with what a restart reads back, and grow without bound.
    const audit = [...nextState.audit, { at: this.now(), ...row }].slice(-PRINCIPAL_AUDIT_MAX_ROWS)
    const committed: PrincipalRegistryState = { ...nextState, audit }
    // Why: persist before the memory swap, so a failed write cannot leave an authority decision
    // live in-process and absent from disk.
    savePrincipalRegistryState(this.registryPath, committed)
    this.state = committed
  }
}

function stripDelegatedGrantId(principal: PrincipalRecord): PrincipalRecord {
  const { delegatedGrantId: _dropped, ...rest } = principal
  return rest
}
