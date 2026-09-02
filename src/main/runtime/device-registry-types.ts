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
  // invalidate a link already handed out.
  pendingExpiresAt?: number
  // S10-16 R1.1: which minted-grant eviction budget this invite counts against, keyed by the issuing
  // lane. Absent ⇒ 'legacy' — a row minted before this field existed (or the sweep, R1.4), which
  // nothing may evict except its own pendingExpiresAt deadline once one is stamped.
  pendingBudgetClass?: BudgetClass
}
