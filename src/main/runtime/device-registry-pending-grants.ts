// Why: the always-mint lane's rules — deadline, sweep, cap — live beside the registry rather than in it,
// so every rule about a named invite is in one place and device-registry.ts keeps its line margin.
import type { DeviceEntry } from './device-registry-types'

// Why: a named invite is handed to one human, so it must not stay a live credential for longer than the
// day it was created — expiry is the leak control that replaces coalescing on the always-mint path.
export const PENDING_GRANT_TTL_MS = 24 * 60 * 60 * 1000

// Why: each minted row is a full bearer credential and the deadline bounds only its lifetime, not how
// many a renderer can pile up inside one window; keep a generous few and drop the oldest.
export const MAX_LIVE_MINTED_GRANTS = 16

// S10-16 R1.1: which minted-grant eviction budget an invite counts against, keyed by the LANE that
// issued it (not by name). 'legacy' is the function-parameter default only — a row minted before
// this field existed and persisted with no `pendingBudgetClass` at all; nothing evicts it (it is
// excluded from retainNewestMintedGrants entirely, below).
export type BudgetClass = 'legacy' | 'host_auto' | 'serve_named' | 'ui_named' | 'lane_invite'

/** A never-connected row carrying its own deadline — i.e. one the always-mint lane created. */
export function isMintedPendingDevice(device: {
  lastSeenAt: number
  pendingExpiresAt?: number
}): boolean {
  return device.lastSeenAt === 0 && device.pendingExpiresAt !== undefined
}

// Why: the deadline is only meaningful while the row is still an un-scanned invite. A scanned row is a
// real pairing and a row without a deadline predates the field, so neither can expire.
// Footgun: only ever true when lastSeenAt === 0 (via isMintedPendingDevice); never combine with a
// lastSeenAt !== 0 filter — the conjunction is always false.
export function isExpiredPendingDevice(device: DeviceEntry, now: number): boolean {
  return isMintedPendingDevice(device) && (device.pendingExpiresAt ?? 0) <= now
}

// Why: the row is the only key to its Relay invite, so dropping it here would strand an unrevokable
// cloud credential — every other removal path queues the durable revoke first, and this lane cannot.
function isDroppablePendingDevice(device: DeviceEntry): boolean {
  return isMintedPendingDevice(device) && device.relayBinding === undefined
}

// Why 'legacy' as the fallback: a row persisted before pendingBudgetClass existed carries no field
// at all (omitted, mirroring pendingExpiresAt's own convention) — its effective class is 'legacy'.
function effectiveBudgetClass(device: DeviceEntry): BudgetClass {
  return device.pendingBudgetClass ?? 'legacy'
}

/** Drops expired minted rows; scanned, legacy and Relay-bound rows are always retained. */
export function retainUnexpiredPendingDevices(devices: DeviceEntry[], now: number): DeviceEntry[] {
  return devices.filter(
    (device) => !isDroppablePendingDevice(device) || !isExpiredPendingDevice(device, now)
  )
}

/**
 * Drops the oldest minted rows past `keep`, WITHIN the given `(scope, budgetClass)` partition only
 * — rows outside the partition are untouchable (S10-16 R1.1). Scanned, Relay-bound and `'legacy'`
 * rows never count against it: a `'legacy'` row cannot be a partition's newest or oldest, so nothing
 * evicts it. Orders by `pairedAt` ASCENDING (creation order), not `pendingExpiresAt` — a
 * deliberately short TTL must never be the first casualty.
 */
export function retainNewestMintedGrants(
  devices: DeviceEntry[],
  keep: number,
  partition: { scope: DeviceEntry['scope']; budgetClass: BudgetClass }
): DeviceEntry[] {
  if (partition.budgetClass === 'legacy') {
    return devices
  }
  const minted = devices.filter(
    (device) =>
      isDroppablePendingDevice(device) &&
      device.scope === partition.scope &&
      effectiveBudgetClass(device) === partition.budgetClass
  )
  if (minted.length <= keep) {
    return devices
  }
  const dropped = new Set(
    [...minted]
      .sort((a, b) => a.pairedAt - b.pairedAt)
      .slice(0, minted.length - keep)
      .map((device) => device.deviceId)
  )
  return devices.filter((device) => !dropped.has(device.deviceId))
}
