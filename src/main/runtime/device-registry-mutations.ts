// Split out of device-registry.ts to stay under the max-lines ratchet: the pure "given the current
// array, compute the next one" half of every mutating DeviceRegistry method. The class itself owns
// only persistence (this.save/this.devices) and the identifiers each caller passes in.
import { randomBytes, randomUUID } from 'node:crypto'
import type { DeviceEntry } from './device-registry-types'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import {
  PENDING_GRANT_TTL_MS,
  isMintedPendingDevice,
  type BudgetClass
} from './device-registry-pending-grants'

/** An invite can only be SHORTENED, never extended past the design's 24h leak-control ceiling. */
export function clampMintTtlMs(ttlMs: number | undefined): number {
  return ttlMs !== undefined && Number.isFinite(ttlMs)
    ? Math.min(Math.max(ttlMs, 1), PENDING_GRANT_TTL_MS)
    : PENDING_GRANT_TTL_MS
}

export function buildDeviceEntry(
  name: string,
  scope: DeviceEntry['scope'],
  pairingReach: RuntimePairingReach,
  pendingExpiresAt?: number,
  // S10-16 R1.1: only ever passed by mintPendingDevice; omitted key ⇒ 'legacy' effective class.
  pendingBudgetClass?: BudgetClass
): DeviceEntry {
  return {
    deviceId: randomUUID(),
    name,
    token: randomBytes(24).toString('hex'),
    scope,
    pairedAt: Date.now(),
    lastSeenAt: 0,
    pairingReach,
    // Why: omit the key entirely when absent so a coalesced grant's persisted shape is unchanged.
    ...(pendingExpiresAt === undefined ? {} : { pendingExpiresAt }),
    ...(pendingBudgetClass === undefined || pendingBudgetClass === 'legacy'
      ? {}
      : { pendingBudgetClass })
  }
}

// Why: a minted row carries a deadline and belongs to one named human, so reusing it here would
// hand that person's link out again as the shared unnamed one. The two lanes stay disjoint by
// construction.
export function findCoalescedPendingDevice(
  devices: DeviceEntry[],
  scope: DeviceEntry['scope']
): DeviceEntry | undefined {
  return devices.find((d) => d.lastSeenAt === 0 && d.scope === scope && !isMintedPendingDevice(d))
}

/** Null when `deviceId` is not found — the caller then skips persistence entirely. */
export function withLastSeenAt(
  devices: DeviceEntry[],
  deviceId: string,
  seenAt: number
): DeviceEntry[] | null {
  if (!devices.some((d) => d.deviceId === deviceId)) {
    return null
  }
  return devices.map((d) => (d.deviceId === deviceId ? { ...d, lastSeenAt: seenAt } : d))
}

export function withPairingReach(
  devices: DeviceEntry[],
  deviceId: string,
  pairingReach: RuntimePairingReach
): DeviceEntry[] {
  return devices.map((d) => (d.deviceId === deviceId ? { ...d, pairingReach } : d))
}

/** Rotate's retain filter: drops the ONE shared, possibly-screenshotted pending row of `scope`. */
export function rotateRetainedDevices(
  devices: DeviceEntry[],
  scope: DeviceEntry['scope']
): DeviceEntry[] {
  return devices.filter((d) => d.lastSeenAt !== 0 || d.scope !== scope || isMintedPendingDevice(d))
}

export function withRelayBinding(
  devices: DeviceEntry[],
  deviceId: string,
  binding: RelayDeviceBinding
): DeviceEntry[] | null {
  if (!devices.some((d) => d.deviceId === deviceId) || binding.relayDeviceId !== deviceId) {
    return null
  }
  return devices.map((d) => (d.deviceId === deviceId ? { ...d, relayBinding: binding } : d))
}

export function withMobilePairingConnectionMode(
  devices: DeviceEntry[],
  deviceId: string,
  mode: MobilePairingConnectionMode
): DeviceEntry[] | null {
  const device = devices.find((d) => d.deviceId === deviceId)
  if (!device || device.scope !== 'mobile') {
    return null
  }
  return devices.map((d) =>
    d.deviceId === deviceId ? { ...d, mobilePairingConnectionMode: mode } : d
  )
}

/** Missing state predates this preference and used automatic direct-first Relay fallback. */
export function readMobilePairingConnectionMode(
  devices: DeviceEntry[],
  deviceId: string
): MobilePairingConnectionMode | null {
  const device = devices.find((d) => d.deviceId === deviceId)
  if (!device || device.scope !== 'mobile') {
    return null
  }
  return device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic'
}
