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
import type { HostConsent } from './principal-consent-authority'
import type { PrincipalRegistry } from './principal-registry'
import type { PrincipalRecord } from './principal-registry-store'

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
    private readonly hostSources: () => LaneHostSources = defaultHostSources
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
    this.registry.assertLaneProvisionable(principalId)
    const lane = provisionPrincipalLane(principalId)
    this.refreshLaneContent(lane.laneDir)
    return lane
  }

  /** Recomputed at creation and on hook refresh (S9 §2a); never merged with lane-side edits. */
  refreshLaneContent(laneDir: string): void {
    const { hostConfigDir, hostConfigPath } = this.hostSources()
    writeLaneSettings(laneDir)
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

function defaultHostSources(): LaneHostSources {
  const paths = new ClaudeRuntimePathResolver().getRuntimePaths()
  return { hostConfigDir: paths.configDir, hostConfigPath: paths.configPath }
}
