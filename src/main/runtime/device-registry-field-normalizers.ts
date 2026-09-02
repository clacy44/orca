// Why: pure per-field normalizers/resolvers for a DeviceEntry, split out of device-registry.ts
// to stay under the max-lines ratchet — device-registry.ts owns persistence and mutation, this
// module owns "what does this field mean" for fields whose interpretation needs a helper.
import type { DeviceScope } from '../../shared/runtime-types'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'

export function validRelayBinding(
  value: unknown,
  deviceId: string
): RelayDeviceBinding | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const binding = value as Partial<RelayDeviceBinding>
  return binding.relayDeviceId === deviceId &&
    typeof binding.relayHostId === 'string' &&
    typeof binding.ownerIdentityKey === 'string'
    ? {
        relayHostId: binding.relayHostId,
        relayDeviceId: binding.relayDeviceId,
        ownerIdentityKey: binding.ownerIdentityKey,
        ...(typeof binding.inviteExpiresAt === 'number' && Number.isFinite(binding.inviteExpiresAt)
          ? { inviteExpiresAt: binding.inviteExpiresAt }
          : {})
      }
    : undefined
}

// S10-19 (§7.3): the ONE place a device's effective access profile is resolved. `device.accessProfile`
// wins when present; absent (every grant minted before this slice) falls back to the host's
// legacyGrantProfile config — 'full' ships, so an un-repaired grant keeps today's behavior exactly.
export function effectiveAccessProfile(
  device: { accessProfile?: 'full' | 'peer' },
  legacyGrantProfile: 'full' | 'peer'
): 'full' | 'peer' {
  return device.accessProfile ?? legacyGrantProfile
}

type LoadedDeviceEntryFields = {
  scope: DeviceScope
  relayBinding: RelayDeviceBinding | undefined
  mobilePairingConnectionMode: MobilePairingConnectionMode
  pairingReach: RuntimePairingReach
  pendingExpiresAt: number | undefined
  accessProfile: 'full' | 'peer' | undefined
}

// Why: the whole per-field disk->memory normalization for one DeviceEntry, split out of
// device-registry.ts's load() to stay under the max-lines ratchet.
export function normalizeLoadedDeviceEntryFields(device: {
  deviceId: string
  scope?: unknown
  relayBinding?: unknown
  mobilePairingConnectionMode?: unknown
  pairingReach?: unknown
  pendingExpiresAt?: unknown
  accessProfile?: unknown
}): LoadedDeviceEntryFields {
  return {
    // Why: older registries only existed for phone pairing. Treat missing
    // scope as mobile so legacy device tokens do not gain new CLI powers.
    scope: device.scope === 'runtime' ? 'runtime' : 'mobile',
    relayBinding: validRelayBinding(device.relayBinding, device.deviceId),
    mobilePairingConnectionMode:
      device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic',
    // Why: registries written before this field existed only ever held network-reach grants
    // (phones and LAN links), so a missing value must keep binding every interface on reconnect.
    pairingReach: device.pairingReach === 'this-computer' ? 'this-computer' : 'network',
    // Why: a non-finite value on disk would make every comparison false and pin the row forever,
    // so normalize anything unusable back to the legacy "never expires" shape.
    pendingExpiresAt:
      typeof device.pendingExpiresAt === 'number' && Number.isFinite(device.pendingExpiresAt)
        ? device.pendingExpiresAt
        : undefined,
    // S10-19 (§7.3): absent (every pre-slice grant) stays undefined — effectiveAccessProfile()
    // resolves that against legacyGrantProfile. A recognized value passes through unchanged.
    // Anything else on disk is unrecognized/corrupt and fails CLOSED to 'peer', never 'full'.
    accessProfile:
      device.accessProfile === 'full' || device.accessProfile === 'peer'
        ? device.accessProfile
        : device.accessProfile === undefined
          ? undefined
          : 'peer'
  }
}
