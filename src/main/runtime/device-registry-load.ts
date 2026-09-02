// Split out of device-registry.ts to stay under the max-lines ratchet: everything needed to turn
// the raw on-disk JSON into the DeviceRegistry's in-memory shape — normalization, the legacy sweep
// (S10-16 R1.4) and the existing expiry sweep — composes into one pure read, so the class itself
// only orchestrates file I/O and persistence.
import { existsSync, readFileSync } from 'node:fs'
import { hardenExistingSecureFile } from '../../shared/secure-file'
import type { DeviceEntry } from './device-registry-types'
import { retainUnexpiredPendingDevices } from './device-registry-pending-grants'
import {
  sweepLegacyCoalescedRuntimeGrants,
  type LegacySweepAuditRow
} from './device-registry-legacy-sweep'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'

function validRelayBinding(value: unknown, deviceId: string): RelayDeviceBinding | undefined {
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

function normalizeLoadedDeviceEntry(device: DeviceEntry): DeviceEntry {
  return {
    ...device,
    // Why: older registries only existed for phone pairing. Treat missing
    // scope as mobile so legacy device tokens do not gain new CLI powers.
    scope: device.scope === 'runtime' ? 'runtime' : 'mobile',
    relayBinding: validRelayBinding(device.relayBinding, device.deviceId),
    mobilePairingConnectionMode:
      device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic',
    // Why: registries written before this field existed only ever held network-reach grants (phones and
    // LAN links), so a missing value must keep binding every interface on reconnect.
    pairingReach: device.pairingReach === 'this-computer' ? 'this-computer' : 'network',
    // Why: a non-finite value on disk would make every comparison false and pin the row forever, so
    // normalize anything unusable back to the legacy "never expires" shape.
    pendingExpiresAt:
      typeof device.pendingExpiresAt === 'number' && Number.isFinite(device.pendingExpiresAt)
        ? device.pendingExpiresAt
        : undefined
  }
}

export type LoadedDeviceRegistry = {
  devices: DeviceEntry[]
  loadSucceeded: boolean
  legacySweepAudit: LegacySweepAuditRow[]
}

/**
 * Reads and normalizes the on-disk registry, then applies (in order): the existing in-memory
 * expiry sweep, then the S10-16 R1.4 legacy sweep (design v6:775-777; S10-16 C1 review F4 restores
 * this order — a v-then-reversed version briefly ran the legacy sweep first, which deleted every
 * swept row whose `pairedAt + 24h` had already passed, before `link-status` or `validateToken`
 * ever saw it stamped). The two sweeps operate on disjoint rows regardless of order — the expiry
 * sweep only drops rows with `pendingExpiresAt !== undefined`, and (since F1) the legacy sweep
 * never writes that field — so this order is not load-bearing for correctness, only for matching
 * the design's stated sequence and for the sweep-owned classification (`grantClass`) to be the
 * thing a caller reads, never a coincidental deletion. Sweeping here (not by rewriting the file)
 * means the next mutation persists the swept array, and rewriting on every construction would pay
 * a secure-file write (two synchronous PowerShell ACL spawns on Windows) for nothing.
 *
 * No file ⇒ an authoritative empty registry, not a failed read. Any other read/parse failure ⇒
 * `loadSucceeded: false` and zero devices — never a partial or reconstructed list.
 */
export function loadDeviceRegistryFile(registryPath: string): LoadedDeviceRegistry {
  if (!existsSync(registryPath)) {
    return { devices: [], loadSucceeded: true, legacySweepAudit: [] }
  }
  try {
    hardenExistingSecureFile(registryPath)
    const parsed = JSON.parse(readFileSync(registryPath, 'utf-8')) as DeviceEntry[]
    const normalized = parsed.map(normalizeLoadedDeviceEntry)
    const unexpired = retainUnexpiredPendingDevices(normalized, Date.now())
    const { devices: swept, audit } = sweepLegacyCoalescedRuntimeGrants(unexpired)
    return {
      devices: swept,
      loadSucceeded: true,
      legacySweepAudit: audit
    }
  } catch {
    return { devices: [], loadSucceeded: false, legacySweepAudit: [] }
  }
}
