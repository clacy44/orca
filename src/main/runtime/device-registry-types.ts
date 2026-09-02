// Split out of device-registry.ts to stay under the max-lines ratchet: the persisted shape, with no
// class or logic attached, so every sibling module (load, mutations, legacy-sweep, pending-grants)
// can depend on it without importing the class file.
import type { DeviceScope } from '../../shared/runtime-types'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { BudgetClass } from './device-registry-pending-grants'

export type { DeviceScope }

export type DeviceEntry = {
  deviceId: string
  name: string
  token: string
  scope: DeviceScope
  pairedAt: number
  lastSeenAt: number
  relayBinding?: RelayDeviceBinding
  mobilePairingConnectionMode?: MobilePairingConnectionMode
  // Why: STA-2370 — a grant minted for "This computer only" proves nothing about off-host reach when its
  // client connects, so the bind decision must be able to tell it apart from a LAN/phone grant.
  pairingReach?: RuntimePairingReach
  // Why: always-minted invites bypass the pending-row coalescing below, so each one carries its own
  // deadline; absent (legacy rows, and every coalesced row) means "never expires", so an upgrade cannot
  // invalidate a link already handed out. S10-16 C1 review F1: written ONLY by mintPendingDevice
  // (INV-P-010) — the R1.4 legacy sweep must never touch this field; it stamps `grantClass` /
  // `legacySweptAt` instead, so a swept row can never be misread as a genuine mint.
  pendingExpiresAt?: number
  // S10-16 R1.1: which minted-grant eviction budget this invite counts against, keyed by the issuing
  // lane. Absent ⇒ 'legacy' — a row persisted before this field existed, which nothing may evict.
  // 'host_auto' is evictable the moment a host_auto mint exists (retainNewestMintedGrants only
  // exempts the literal 'legacy' partition) — the R1.4 sweep's stamp is deliberately in that class.
  pendingBudgetClass?: BudgetClass
  // S10-16 C1 review F1 — the mint-time fact R15.1-equivalent classification must key on, instead of
  // inferring "minted" from pendingExpiresAt's mere presence (which the sweep below no longer sets
  // anyway). Written by mintPendingDevice ('minted') and by the legacy sweep ('legacy_coalesced')
  // only; absent on a row minted before this field existed (isMintedPendingDevice falls back to the
  // pre-existing pendingExpiresAt-presence heuristic for exactly that case, never for a fresh write).
  grantClass?: 'minted' | 'legacy_coalesced'
  // S10-16 C1 review F1/F4 — when the R1.4 sweep classified this row. Purely a marker (idempotency
  // guard + audit provenance): the actual TTL deadline for an un-consumed legacy_coalesced row is
  // always recomputed from the immutable `pairedAt` (protocol M7), never stored here.
  legacySweptAt?: number
}
