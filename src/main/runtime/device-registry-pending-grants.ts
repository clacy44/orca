// Why: the always-mint lane's rules — deadline, sweep, cap — live beside the registry rather than in it,
// so every rule about a named invite is in one place and device-registry.ts keeps its line margin.
import type { DeviceEntry } from './device-registry'

// Why: a named invite is handed to one human, so it must not stay a live credential for longer than the
// day it was created — expiry is the leak control that replaces coalescing on the always-mint path.
export const PENDING_GRANT_TTL_MS = 24 * 60 * 60 * 1000

// Why: each minted row is a full bearer credential and the deadline bounds only its lifetime, not how
// many a renderer can pile up inside one window; keep a generous few and drop the oldest.
export const MAX_LIVE_MINTED_GRANTS = 16

/** A never-connected row carrying its own deadline — i.e. one the always-mint lane created. */
export function isMintedPendingDevice(device: {
  lastSeenAt: number
  pendingExpiresAt?: number
}): boolean {
  return device.lastSeenAt === 0 && device.pendingExpiresAt !== undefined
}

// Why: the deadline is only meaningful while the row is still an un-scanned invite. A scanned row is a
// real pairing and a row without a deadline predates the field, so neither can expire.
export function isExpiredPendingDevice(device: DeviceEntry, now: number): boolean {
  return isMintedPendingDevice(device) && (device.pendingExpiresAt ?? 0) <= now
}

// Why: the row is the only key to its Relay invite, so dropping it here would strand an unrevokable
// cloud credential — every other removal path queues the durable revoke first, and this lane cannot.
function isDroppablePendingDevice(device: DeviceEntry): boolean {
  return isMintedPendingDevice(device) && device.relayBinding === undefined
}

/** Drops expired minted rows; scanned, legacy and Relay-bound rows are always retained. */
export function retainUnexpiredPendingDevices(devices: DeviceEntry[], now: number): DeviceEntry[] {
  return devices.filter(
    (device) => !isDroppablePendingDevice(device) || !isExpiredPendingDevice(device, now)
  )
}

/** Drops the oldest minted rows past `keep`; scanned and Relay-bound rows never count against it. */
export function retainNewestMintedGrants(devices: DeviceEntry[], keep: number): DeviceEntry[] {
  const minted = devices.filter(isDroppablePendingDevice)
  if (minted.length <= keep) {
    return devices
  }
  const dropped = new Set(
    [...minted]
      .sort((a, b) => (a.pendingExpiresAt ?? 0) - (b.pendingExpiresAt ?? 0))
      .slice(0, minted.length - keep)
      .map((device) => device.deviceId)
  )
  return devices.filter((device) => !dropped.has(device.deviceId))
}
