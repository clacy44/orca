// S10-16 R1.4: split out of device-registry.ts to stay under the max-lines ratchet — the sweep is
// pure (no secret material, no persistence), so it lives beside device-registry-pending-grants.ts
// rather than inside the class it's called from.
import type { DeviceEntry } from './device-registry-types'
import { PENDING_GRANT_TTL_MS } from './device-registry-pending-grants'

// One row per legacy-coalesced runtime grant the sweep stamped with a deadline.
export type LegacySweepAuditRow = {
  deviceId: string
  name: string
  pairedAt: number
  pendingExpiresAt: number
}

/**
 * After R1, a pre-existing un-consumed COALESCED runtime row (no `pendingExpiresAt`, never
 * scanned) is unreachable by `rotatePendingDevice` / `retainNewestMintedGrants` /
 * `retainUnexpiredPendingDevices` and accepted forever by `validateToken` — a bearer credential
 * stranded with no revocation path. Called once per process, on every host, inside
 * `DeviceRegistry::load()`, before `registryLoadSucceeded` is set — so a host that never mints (no
 * `orca serve` restart, no pairing UI use) still sweeps.
 *
 * v6 (protocol M7): the deadline is derived from `pairedAt`, NOT from `now` — `pairedAt` is
 * written once and never mutated, so the stamp is byte-identical on every load, with or without an
 * intervening save. Stamping from `now` would slide the deadline forward on every restart on a
 * host that restarts more often than it writes its registry, making the credential exactly as
 * un-expiring as before R1.4.
 *
 * Scope-guarded to `runtime`; `mobile`, already-`relayBinding`-holding and already-connected
 * (`lastSeenAt !== 0`) rows are untouched — a scanned row is a real pairing, not a leak.
 *
 * The audit row this sweep owes (one per stamped row) is deferred to the caller of `save()` —
 * `load()` runs before the orchestration DB exists to receive it, and the stamp itself is durable
 * regardless. The returned `audit` array is what a caller writes once a sink is available.
 */
export function sweepLegacyCoalescedRuntimeGrants(devices: DeviceEntry[]): {
  devices: DeviceEntry[]
  audit: LegacySweepAuditRow[]
} {
  const audit: LegacySweepAuditRow[] = []
  const swept = devices.map((device) => {
    if (
      device.scope !== 'runtime' ||
      device.lastSeenAt !== 0 ||
      device.pendingExpiresAt !== undefined ||
      device.relayBinding !== undefined
    ) {
      return device
    }
    const pendingExpiresAt = device.pairedAt + PENDING_GRANT_TTL_MS
    audit.push({
      deviceId: device.deviceId,
      name: device.name,
      pairedAt: device.pairedAt,
      pendingExpiresAt
    })
    return { ...device, pendingExpiresAt, pendingBudgetClass: 'host_auto' as const }
  })
  return { devices: swept, audit }
}
