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

export type LinkBindingSelfView = {
  /** `hashCallerCredential` of the registry token for this deviceId, or null if unknown. NEVER
   *  returns a token. */
  registryCredentialFingerprint(deviceId: string): string | null
  /** `fingerprintOrchestrationPeer(getE2EEPublicKey())`, or null if no E2EE key is armed. */
  ownKeyFingerprint(): string | null
  /** The MAC a selector scan needs, computed beside the secret. NEVER returns a token. */
  macWithRegistryToken(deviceId: string, label: string, fields: readonly string[]): string | null
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
    }
  }
}
