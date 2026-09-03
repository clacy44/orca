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
import { normalizeLoadedDeviceEntryFields } from './device-registry-field-normalizers'

// Why one delegated call rather than the per-field block that used to live here: S10-19 owns the
// per-field disk->memory normalization (device-registry-field-normalizers.ts), including
// `accessProfile`'s fail-closed rule (an unrecognized value on disk becomes 'peer', never 'full').
// Two copies of that logic would drift, and the fail-closed clause is exactly the one that must
// not be missed on this path — load() is the only route a persisted profile takes into memory.
function normalizeLoadedDeviceEntry(device: DeviceEntry): DeviceEntry {
  return {
    ...device,
    ...normalizeLoadedDeviceEntryFields(device)
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
