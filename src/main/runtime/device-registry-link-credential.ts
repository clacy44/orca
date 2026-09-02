// S10-16 R9: registry-side self-view for the link-binding responder. Takes a `DeviceRegistry` and
// an own-public-key accessor and returns ONLY MACs and fingerprints — never a token. PART 0.3(4)
// already states this is hygiene, not a trust boundary: the values returned are exactly what a
// caller already holding the DeviceRegistry could compute itself; this module exists so the RPC
// handler (which sees only `OrcaRuntimeService`, never `RuntimeRpcServer`) can reach them without
// a second, wider surface being exposed.
import type { DeviceRegistry } from './device-registry'
import { hashCallerCredential } from './principal-link-fingerprint-binding'
import { fingerprintOrchestrationPeer } from './orchestration/environment-transport'
import { linkBindingMac } from './orchestration/link-binding-proof'
import { deriveGrantClassAtBind } from './orchestration/link-binding-classify'

export type LinkBindingCandidateLink = {
  deviceId: string
  pairedAt: number
  grantClass: 'minted' | 'legacy_coalesced'
}

export type LinkBindingSelfView = {
  /** `hashCallerCredential` of the registry token for this deviceId, or null if unknown. NEVER
   *  returns a token. */
  registryCredentialFingerprint(deviceId: string): string | null
  /** `fingerprintOrchestrationPeer(getE2EEPublicKey())`, or null if no E2EE key is armed. */
  ownKeyFingerprint(): string | null
  /** The MAC a selector scan needs, computed beside the secret. NEVER returns a token. */
  macWithRegistryToken(deviceId: string, label: string, fields: readonly string[]): string | null
  /** S10-16 C4, R10-A: every runtime-scope link that has actually authenticated
   *  (`scope==='runtime' && lastSeenAt !== 0`), with the grant-class fact R15.1's `routingClass`
   *  needs at bind time. Never a token. */
  listRuntimeLinkCandidates(): readonly LinkBindingCandidateLink[]
  /** S10-16 C5, R15.3/R18.4(a): `deviceRegistry.loadSucceeded` — false only on a genuine parse/
   *  read failure of `orca-devices.json`, never on an empty/missing file. */
  registryLoadSucceeded(): boolean
}

export function createLinkBindingSelfView(
  deviceRegistry: DeviceRegistry,
  getOwnPublicKeyB64: () => string | null
): LinkBindingSelfView {
  return {
    registryCredentialFingerprint(deviceId: string): string | null {
      const device = deviceRegistry.getDevice(deviceId)
      return device ? hashCallerCredential(device.token) : null
    },
    ownKeyFingerprint(): string | null {
      const publicKeyB64 = getOwnPublicKeyB64()
      return publicKeyB64 ? fingerprintOrchestrationPeer(publicKeyB64) : null
    },
    macWithRegistryToken(
      deviceId: string,
      label: string,
      fields: readonly string[]
    ): string | null {
      const device = deviceRegistry.getDevice(deviceId)
      return device ? linkBindingMac(device.token, label, fields) : null
    },
    listRuntimeLinkCandidates(): readonly LinkBindingCandidateLink[] {
      return deviceRegistry
        .listDevices()
        .filter((d) => d.scope === 'runtime' && d.lastSeenAt !== 0)
        .map((d) => ({
          deviceId: d.deviceId,
          pairedAt: d.pairedAt,
          grantClass: deriveGrantClassAtBind(d)
        }))
    },
    registryLoadSucceeded(): boolean {
      return deviceRegistry.loadSucceeded
    }
  }
}
