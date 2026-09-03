// S10-16 R1.4: split out of device-registry.ts to stay under the max-lines ratchet — the sweep is
// pure (no secret material, no persistence), so it lives beside device-registry-pending-grants.ts
// rather than inside the class it's called from.
import type { DeviceEntry } from './device-registry-types'
import { PENDING_GRANT_TTL_MS } from './device-registry-pending-grants'

// One row per legacy-coalesced runtime grant the sweep classified. `legacyExpiresAt` is the
// deadline the row now carries (derived, never persisted onto the entry — see below); it is NOT
// `DeviceEntry.pendingExpiresAt`, which this sweep never writes (S10-16 C1 review F1/INV-P-010).
export type LegacySweepAuditRow = {
  deviceId: string
  name: string
  pairedAt: number
  legacyExpiresAt: number
}

/**
 * After R1, a pre-existing un-consumed COALESCED runtime row (no `pendingExpiresAt`, never
 * scanned) is unreachable by `rotatePendingDevice` / `retainNewestMintedGrants` /
 * `retainUnexpiredPendingDevices` and accepted forever by `validateToken` — a bearer credential
 * stranded with no revocation path. Called once per process, on every host, inside
 * `DeviceRegistry::load()`, before `registryLoadSucceeded` is set — so a host that never mints (no
 * `orca serve` restart, no pairing UI use) still sweeps.
 *
 * S10-16 C1 review F1: this sweep must NEVER write `pendingExpiresAt` — that field is minted-grant
 * evidence (INV-P-010: written only by `mintPendingDevice`), and R15.1-equivalent classification
 * (`isMintedPendingDevice`) derives from it. Writing it here would let a swept row read as a genuine
 * mint the instant it is consumed. Instead the row is stamped with `grantClass:
 * 'legacy_coalesced'` and `legacySweptAt` — a fact `isMintedPendingDevice` reads FIRST, so a swept
 * row can never be misclassified. The deadline itself (`pairedAt + PENDING_GRANT_TTL_MS`) is never
 * stored on the entry either; `isExpiredLegacyCoalescedGrant` recomputes it from the immutable
 * `pairedAt` at check time (byte-identical by construction, protocol M7's property for free).
 *
 * Scope-guarded to `runtime`; `mobile`, already-`relayBinding`-holding, already-connected
 * (`lastSeenAt !== 0`) and already-classified (`grantClass` set — idempotency, so a second load
 * with no intervening save does not re-append an audit row for the same in-memory pass) rows are
 * untouched — a scanned row is a real pairing, not a leak.
 *
 * S10-16 C1 review F4: the sweep itself never deletes (still a pure same-length `map`), and per the
 * design's stated order it now runs AFTER the expiry sweep (`device-registry-load.ts`) — a swept
 * row is kept, refused for routing once past its deadline, and stays listable.
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
  const sweptAt = Date.now()
  const swept = devices.map((device) => {
    if (
      device.scope !== 'runtime' ||
      device.lastSeenAt !== 0 ||
      device.grantClass !== undefined ||
      device.pendingExpiresAt !== undefined ||
      device.relayBinding !== undefined
    ) {
      return device
    }
    audit.push({
      deviceId: device.deviceId,
      name: device.name,
      pairedAt: device.pairedAt,
      legacyExpiresAt: device.pairedAt + PENDING_GRANT_TTL_MS
    })
    return {
      ...device,
      grantClass: 'legacy_coalesced' as const,
      legacySweptAt: sweptAt,
      pendingBudgetClass: 'host_auto' as const
    }
  })
  return { devices: swept, audit }
}
