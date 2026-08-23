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
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { HostConsent } from './principal-consent-authority'
import type { PrincipalRegistry } from './principal-registry'
import type { PrincipalRecord } from './principal-registry-store'

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
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  createPrincipal(consent: HostConsent, displayName: string): PrincipalRecord {
    return this.registry.createPrincipal(consent, displayName)
  }

  listPrincipals(): readonly PrincipalRecord[] {
    return this.registry.listPrincipals()
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

  bindFederatedLink(consent: HostConsent, homePeerFingerprint: string): { boundDeviceId: string } {
    const grant = this.registry.bindFederatedLink(consent, homePeerFingerprint)
    return { boundDeviceId: grant.deviceId }
  }

  /** Provisioning is an event: bound grant, designated pusher, then the lane and its content. */
  provisionLane(consent: HostConsent, principalId: string): ProvisionedPrincipalLane {
    void consent
    assertProvisioningPlatformCleared(this.platform)
    this.registry.assertLaneProvisionable(principalId)
    const lane = provisionPrincipalLane(principalId)
    this.refreshLaneContent(lane.laneDir)
    return lane
  }

  /** Recomputed at creation and on hook refresh (S9 §2a); never merged with lane-side edits. */
  refreshLaneContent(laneDir: string): void {
    const { hostConfigDir, hostConfigPath } = this.hostSources()
    // Why derived from the config dir rather than defaulted: the lane's settings must mirror the
    // same shared lane the memory and MCP mirror read, not whatever homedir() resolves to.
    writeLaneSettings(laneDir, { hostConfigPath: join(hostConfigDir, 'settings.json') })
    mirrorHostUserContentIntoLane(hostConfigDir, laneDir)
    seedFreshLaneConfig(laneDir, hostConfigPath)
  }

  deprovisionLane(consent: HostConsent, principalId: string): boolean {
    void consent
    const laneDir = resolveOwnedPrincipalLaneDir(principalId)
    if (laneDir) {
      // Why: wipe before removing the tree, so a failed rmdir still leaves no credential at rest.
      wipeLaneCredentials(laneDir)
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

function assertProvisioningPlatformCleared(platform: NodeJS.Platform): void {
  const gate = PROVISIONING_GATED_PLATFORMS[platform]
  if (gate) {
    throw new ClaudeLaneRefusal(
      'accounts.lane.provisioning_platform_gated',
      `Per-person Claude credential lanes are not enabled on ${gate.label} yet: Orca has not yet confirmed that the Claude CLI keeps every credential inside the folder each lane names on this platform (S9 §5 live probe ${gate.probe}). Until it does, run per-person lanes on a Linux host.`
    )
  }
}

function defaultHostSources(): LaneHostSources {
  const paths = new ClaudeRuntimePathResolver().getRuntimePaths()
  return { hostConfigDir: paths.configDir, hostConfigPath: paths.configPath }
}
