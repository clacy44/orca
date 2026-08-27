import { join } from 'node:path'
import { ClaudeRuntimePathResolver } from '../claude-accounts/runtime-paths'
import {
  deprovisionPrincipalLane,
  provisionPrincipalLane,
  resolveOwnedPrincipalLaneDir,
  type ProvisionedPrincipalLane
} from '../claude-accounts/principal-credential-lane'
import { wipeLaneCredentials } from '../claude-accounts/principal-lane-credential-sweep'
import { seedFreshLaneConfig } from '../claude-accounts/principal-lane-config-seed'
import { writeLaneSettings } from '../claude-accounts/principal-lane-settings'
import { mirrorHostUserContentIntoLane } from '../claude-accounts/principal-lane-user-content-mirror'
import { reconcileOrphanPrincipalLanes } from '../claude-accounts/principal-lane-orphan-reconciliation'
import { resolveLaneResidencyState } from '../claude-accounts/principal-lane-residency'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { DeviceScope, RuntimeTerminalLaneState } from '../../shared/runtime-types'
import { normalizePairingDeviceName } from '../../shared/pairing-device-name'
import type { HostConsent } from './principal-consent-authority'
import type { LaneGrantSummary, PrincipalRegistry } from './principal-registry'
import type {
  PrincipalAuditRow,
  PrincipalPlatformAcceptance,
  PrincipalRecord
} from './principal-registry-store'

/**
 * The one seam a runtime-time named invite (`accounts.lane.mintInvite`) crosses into
 * `RuntimeRpcServer.createPairingOffer` — optional because a remote-host runtime proxy has no
 * pairing surface of its own to arm (same convention as `PrincipalLaneHostRuntime`).
 */
export type PairingInviteOfferArgs = {
  address?: string | null
  name: string
  mint: 'always'
  scope: DeviceScope
  reach: 'network'
  ttlMs?: number
}

export type PairingInviteOfferResult =
  | { available: false; reason: string; guidance: string }
  | {
      available: true
      pairingUrl: string
      endpoint: string
      deviceId: string
      webClientUrl: string | null
    }

export type PairingInviteSource = {
  createPairingOffer: (args: PairingInviteOfferArgs) => PairingInviteOfferResult
  advertisedAddress: () => string | null
}

/**
 * §6's S9a merge gates (i) and (ii), in code rather than in a note.
 *
 * Provisioning stays OFF on these platforms until the named §5 live probe establishes that the
 * platform's Claude CLI keeps no credential state outside `CLAUDE_CONFIG_DIR` — the failure class
 * is every lane collapsing onto one credential, which no test in this repo can observe. Gate (iii)
 * — a native Windows lane's DACL verifying at creation — is enforced per lane in
 * `principal-credential-lane.ts`. Opening a gate is the deletion of its row, beside its evidence.
 */
const PROVISIONING_GATED_PLATFORMS: Partial<
  Record<NodeJS.Platform, { label: string; probe: string }>
> = {
  darwin: { label: 'macOS', probe: 'step (8)' },
  win32: { label: 'Windows', probe: 'step (10)' }
}

export type LaneHostSources = {
  /** The shared lane's config dir and `.claude.json`; the mirror and the seed read these. */
  hostConfigDir: string
  hostConfigPath: string
}

/**
 * The host-side consent surface: the five registry writes plus provision/deprovision.
 *
 * Every entry point takes a `HostConsent`, so the local-caller check is the only door in. Lane
 * content is recomputed here rather than at launch, which is what makes the mirror one-way and
 * host-computed — nothing a client sends reaches a lane's settings.
 */
export class PrincipalLaneConsentService {
  constructor(
    private readonly registry: PrincipalRegistry,
    private readonly hostSources: () => LaneHostSources = defaultHostSources,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly pairing?: PairingInviteSource
  ) {}

  createPrincipal(consent: HostConsent, displayName: string): PrincipalRecord {
    return this.registry.createPrincipal(consent, displayName)
  }

  listPrincipals(): readonly PrincipalRecord[] {
    return this.registry.listPrincipals()
  }

  /** The audit log — the host-only surface's undo trail; deletions stay visible (§2a rule (iii)). */
  listAudit(): readonly PrincipalAuditRow[] {
    return this.registry.listAudit()
  }

  /** The still-surviving grants bound to a principal; the bridge joins these into binding rows. */
  boundDeviceIds(principalId: string): string[] {
    return this.registry.boundDeviceIds(principalId)
  }

  /** The full grant roster the local `orca lane` verbs resolve a device selector against. */
  listGrants(): LaneGrantSummary[] {
    return this.registry.listGrants()
  }

  /** Whether this principal's lane holds a credential on this host right now (§2h). */
  laneResidencyState(principalId: string): RuntimeTerminalLaneState {
    return resolveLaneResidencyState(principalId, { platform: this.platform })
  }

  bindGrant(consent: HostConsent, deviceId: string, principalId: string): void {
    this.registry.bindGrant(consent, deviceId, principalId)
  }

  unbindGrant(consent: HostConsent, deviceId: string): boolean {
    return this.registry.unbindGrant(consent, deviceId)
  }

  rebindGrant(consent: HostConsent, deviceId: string, principalId: string): void {
    this.registry.rebindGrant(consent, deviceId, principalId)
  }

  designatePusher(consent: HostConsent, principalId: string, deviceId: string): void {
    this.registry.designatePusher(consent, principalId, deviceId)
  }

  /**
   * The runtime-time mint (spec `orca lane invite`): a per-person named invite for a headless
   * host, where the only prior door was `orca serve --pair-name` at launch. It does NOT bind —
   * `bindGrant` still refuses an un-redeemed invite, so bind stays the separate second consent
   * write after the desktop opens the link.
   */
  mintInvite(
    consent: HostConsent,
    params: { principalId: string; scope: DeviceScope; ttlHours?: number; address?: string }
  ): {
    deviceId: string
    deviceIdPrefix: string
    principalId: string
    displayName: string
    scope: DeviceScope
    expiresAt: number
    pairingUrl: string
    webClientUrl: string | null
    endpoint: string
  } {
    const person = this.registry
      .listPrincipals()
      .find((row) => row.principalId === params.principalId)
    if (!person) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.person_unknown',
        'Orca has no record of that person. Create them first with `orca lane create-person --name <name>`, then invite them.'
      )
    }
    const name = normalizePairingDeviceName(person.displayName)
    if (!name) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.invite_name_invalid',
        `"${person.displayName}" does not normalize to a printable pairing label. Rename them with \`orca lane create-person\` before inviting.`
      )
    }
    if (!this.pairing) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.invite_unavailable',
        'Pairing is not available on this host, so Orca cannot mint an invite. Check that WebSocket pairing started and try again.'
      )
    }
    const offer = this.pairing.createPairingOffer({
      address: params.address ?? this.pairing.advertisedAddress(),
      name,
      mint: 'always',
      scope: params.scope,
      reach: 'network',
      ...(params.ttlHours !== undefined ? { ttlMs: params.ttlHours * 3_600_000 } : {})
    })
    if (!offer.available) {
      // Rule 3: an old client has no string for a new code, so the offer's own guidance sentence
      // must be complete on its own — the same discipline as `accounts.lane.push_malformed`.
      throw new ClaudeLaneRefusal('accounts.lane.invite_unavailable', offer.guidance)
    }
    const { expiresAt } = this.registry.recordInviteMinted(consent, offer.deviceId, {
      principalId: params.principalId,
      scope: params.scope
    })
    return {
      deviceId: offer.deviceId,
      deviceIdPrefix: offer.deviceId.slice(0, 8),
      principalId: params.principalId,
      displayName: person.displayName,
      scope: params.scope,
      expiresAt,
      pairingUrl: offer.pairingUrl,
      webClientUrl: offer.webClientUrl,
      endpoint: offer.endpoint
    }
  }

  bindFederatedLink(consent: HostConsent, homePeerFingerprint: string): { boundDeviceId: string } {
    const grant = this.registry.bindFederatedLink(consent, homePeerFingerprint)
    return { boundDeviceId: grant.deviceId }
  }

  /** Provisioning is an event: bound grant, designated pusher, then the lane and its content. */
  provisionLane(
    consent: HostConsent,
    principalId: string,
    options: { acceptUnverifiedPlatform?: boolean } = {}
  ): ProvisionedPrincipalLane {
    const accepted = options.acceptUnverifiedPlatform === true
    const gate = PROVISIONING_GATED_PLATFORMS[this.platform]
    assertProvisioningPlatformCleared(this.platform, accepted)
    this.registry.assertLaneProvisionable(principalId)
    // Why the platform is threaded rather than left to `process.platform`: one call must not read
    // two platform answers — the UNC refusal, the DACL arm and the gate above are one decision.
    const lane = provisionPrincipalLane(principalId, { platform: this.platform })
    this.refreshLaneContent(principalId)
    // B2: only a cleared gate records an override; an ungated platform (e.g. linux) records none.
    this.registry.recordLaneProvisioned(
      consent,
      principalId,
      gate && accepted ? platformAcceptanceFor(this.platform) : undefined
    )
    return lane
  }

  /** One-line getter the consent bridge reads to decide whether to offer the override checkbox. */
  get provisioningPlatformGate(): {
    platform: NodeJS.Platform
    label: string
    probe: string
  } | null {
    const gate = PROVISIONING_GATED_PLATFORMS[this.platform]
    return gate ? { platform: this.platform, label: gate.label, probe: gate.probe } : null
  }

  /**
   * Recomputed at creation and on hook refresh (S9 §2a); never merged with lane-side edits.
   *
   * Keyed by principal rather than by path: the mirror creates its target directory and fills it
   * with the host's memory, agents, commands and skills, so a raw path from a later caller — §2a
   * names hook refresh as the second one — would produce an unmarked, unhardened lane look-alike.
   */
  refreshLaneContent(principalId: string): void {
    const laneDir = resolveOwnedPrincipalLaneDir(principalId, { platform: this.platform })
    if (!laneDir) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.lane_not_owned_by_orca',
        "Orca could not prove that this person's credential lane is its own, so it did not write to it. Provision the lane again from Orca on the host machine."
      )
    }
    const { hostConfigDir, hostConfigPath } = this.hostSources()
    // Why derived from the config dir rather than defaulted: the lane's settings must mirror the
    // same shared lane the memory and MCP mirror read, not whatever homedir() resolves to.
    writeLaneSettings(laneDir, { hostConfigPath: join(hostConfigDir, 'settings.json') })
    mirrorHostUserContentIntoLane(hostConfigDir, laneDir, { platform: this.platform })
    seedFreshLaneConfig(laneDir, hostConfigPath)
  }

  /** Async only because §2f's wipe reaches the lane's macOS Keychain item, not just its files. */
  async deprovisionLane(consent: HostConsent, principalId: string): Promise<boolean> {
    void consent
    const laneDir = resolveOwnedPrincipalLaneDir(principalId)
    if (laneDir) {
      // Why: wipe before removing the tree, so a failed rmdir still leaves no credential at rest.
      await wipeLaneCredentials(laneDir, { platform: this.platform })
    }
    return deprovisionPrincipalLane(principalId)
  }

  /** Startup sweep; the gate lives in the reconciler and reads both load flags. */
  reconcileOrphanLanes(): string[] {
    return reconcileOrphanPrincipalLanes({
      boundPrincipalIds: this.registry.boundPrincipalIds(),
      registryLoadSucceeded: this.registry.loadSucceeded
    }).deletedPrincipalIds
  }
}

let attachedSurface: PrincipalLaneConsentService | null = null

export function attachPrincipalLaneConsentService(
  service: PrincipalLaneConsentService | null
): void {
  attachedSurface = service
}

export function getPrincipalLaneConsentService(): PrincipalLaneConsentService | null {
  return attachedSurface
}

function assertProvisioningPlatformCleared(platform: NodeJS.Platform, accepted: boolean): void {
  const gate = PROVISIONING_GATED_PLATFORMS[platform]
  if (!gate || accepted) {
    return
  }
  throw new ClaudeLaneRefusal(
    'accounts.lane.provisioning_platform_gated',
    `Per-person Claude credential lanes are not enabled on ${gate.label} yet: Orca has not yet confirmed that the Claude CLI keeps every credential inside the folder each lane names on this platform (S9 §5 live probe ${gate.probe}). Run per-person lanes on a Linux host, or accept that risk explicitly with \`orca lane provision --person <name> --accept-unverified-platform\`.`
  )
}

/** The audit row's shape for a §6 override — the platform name, never a free-form label. */
function platformAcceptanceFor(platform: NodeJS.Platform): PrincipalPlatformAcceptance {
  return platform === 'win32' ? 'unverified-win32' : 'unverified-darwin'
}

function defaultHostSources(): LaneHostSources {
  const paths = new ClaudeRuntimePathResolver().getRuntimePaths()
  return { hostConfigDir: paths.configDir, hostConfigPath: paths.configPath }
}
