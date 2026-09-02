// Why: per-device tokens replace the shared runtime auth token for WebSocket (mobile) connections —
// each paired device gets its own revocable token so compromising one device doesn't expose others.
// The registry is a simple JSON file with hardened permissions matching the runtime metadata pattern.
import { join } from 'node:path'
import { writeSecureJsonFile } from '../../shared/secure-file'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import {
  MAX_LIVE_MINTED_GRANTS,
  isExpiredPendingDevice,
  isExpiredLegacyCoalescedGrant,
  isMintedPendingDevice,
  retainNewestMintedGrants,
  retainUnexpiredPendingDevices,
  type BudgetClass
} from './device-registry-pending-grants'
import { loadDeviceRegistryFile } from './device-registry-load'
import { DeferredFlushTimer } from './device-registry-deferred-flush'
import type { LegacySweepAuditRow } from './device-registry-legacy-sweep'
import {
  buildDeviceEntry,
  clampMintTtlMs,
  findCoalescedPendingDevice,
  readMobilePairingConnectionMode,
  rotateRetainedDevices,
  withLastSeenAt,
  withMobilePairingConnectionMode,
  withPairingReach,
  withRelayBinding
} from './device-registry-mutations'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { DeviceEntry, DeviceScope } from './device-registry-types'
import { effectiveAccessProfile } from './device-registry-field-normalizers'

export { effectiveAccessProfile }

export type { DeviceScope, DeviceEntry }
export type { LegacySweepAuditRow }

// Why: a lastSeen refresh is pure bookkeeping, so coalesce reconnect bursts into one write instead of
// paying a secure-file rewrite (two synchronous PowerShell ACL spawns on Windows) per connection.
const LAST_SEEN_FLUSH_DELAY_MS = 250

export class DeviceRegistry {
  private readonly registryPath: string
  private devices: DeviceEntry[] = []
  private readonly lastSeenFlush = new DeferredFlushTimer(LAST_SEEN_FLUSH_DELAY_MS, () =>
    this.flushPendingLastSeen()
  )
  // Why: a failed load yields zero devices, which any "delete what no device claims" sweep
  // would read as "delete everything". Only a completed read/normalize sets this.
  private registryLoadSucceeded = false
  // S10-16 R1.4: audit rows the legacy-coalesced-grant sweep owes, queued here because load() runs
  // before the orchestration DB exists to receive them.
  private pendingLegacySweepAudit: LegacySweepAuditRow[] = []

  constructor(userDataPath: string) {
    this.registryPath = join(userDataPath, DEVICE_REGISTRY_FILENAME)
    this.load()
  }

  addDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    accessProfile: 'full' | 'peer' = 'full'
  ): DeviceEntry {
    return this.createAndPersistDevice(this.devices, name, scope, pairingReach, accessProfile)
  }

  // Entry construction is pure (device-registry-mutations.ts); this owns only persistence — a
  // credential is not valid until its durable registry write succeeds.
  private createAndPersistDevice(
    existingDevices: DeviceEntry[],
    name: string,
    scope: DeviceScope,
    pairingReach: RuntimePairingReach,
    // S10-19 R10: always written, never omitted — unlike pendingExpiresAt, a missing accessProfile
    // on a freshly-minted row would be indistinguishable from a pre-S10-19 legacy grant.
    accessProfile: 'full' | 'peer' = 'full',
    pendingExpiresAt?: number,
    // S10-16 R1.1: only ever passed by mintPendingDevice; omitted key ⇒ 'legacy' effective class.
    pendingBudgetClass?: BudgetClass
  ): DeviceEntry {
    const entry = buildDeviceEntry(
      name,
      scope,
      pairingReach,
      accessProfile,
      pendingExpiresAt,
      pendingBudgetClass
    )
    const nextDevices = [...existingDevices, entry]
    this.save(nextDevices)
    this.devices = nextDevices
    return entry
  }

  // Why: coalesce repeated QR-regenerate clicks onto a single pending token — each call to
  // addDevice() produces a valid auth credential, and without coalescing every renderer call to
  // mobile:getPairingQR (e.g. the copy-button flow that encourages regeneration) leaves an orphaned
  // token forever. Returns an existing never-scanned entry if present; otherwise mints a new one.
  getOrCreatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    accessProfile: 'full' | 'peer' = 'full',
    // Why: resolves a legacy (pre-S10-19) pending row's effective profile for the coalescing
    // comparison below; the host's legacyGrantProfile config, ships 'full'.
    legacyGrantProfile: 'full' | 'peer' = 'full'
  ): DeviceEntry {
    const existing = findCoalescedPendingDevice(
      this.devices,
      scope,
      Date.now(),
      accessProfile,
      legacyGrantProfile
    )
    if (existing) {
      // Why: the same pending token can be re-advertised at a broader reach; widen it but never narrow it,
      // or a link already handed out for off-host use would stop being served after the next launch.
      return pairingReach === 'network' && existing.pairingReach === 'this-computer'
        ? this.setPairingReach(existing, 'network')
        : existing
    }
    return this.addDevice(name, scope, pairingReach, accessProfile)
  }

  // Why: two humans handed one coalesced link land on one deviceId/token, so nothing downstream can
  // tell them apart — a grant can only be split per person at offer time, so this path mints a fresh
  // row every call and never reuses a pending one. Unlike rotatePendingDevice it keeps sibling
  // pending rows, so minting Ben's invite cannot kill Ana's un-scanned one.
  mintPendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    // Why clamped to (0, PENDING_GRANT_TTL_MS] rather than accepted verbatim: an invite can only be
    // SHORTENED, never extended past the design's leak control (S9 §2a's 24h ceiling).
    ttlMs?: number,
    accessProfile: 'full' | 'peer' = 'full',
    // S10-16 C1 review F7 (finding 8): the default is FAIL-CLOSED. 'legacy' means "no field at all
    // on disk", exempt from the cap entirely — a caller that omits this must NOT land there, or a
    // future mint lane that forgets to declare its class gets an uncapped credential store instead
    // of a compile error. 'unspecified' is a real, capped partition.
    budgetClass: BudgetClass = 'unspecified'
  ): DeviceEntry {
    const now = Date.now()
    const clampedTtlMs = clampMintTtlMs(ttlMs)
    // Why: the cap leaves room for the row about to be appended, so no window ever holds more than
    // MAX_LIVE_MINTED_GRANTS live invites in this partition, no matter how often the caller mints.
    const unexpired = retainUnexpiredPendingDevices(this.devices, now)
    const retained = retainNewestMintedGrants(unexpired, MAX_LIVE_MINTED_GRANTS - 1, {
      scope,
      budgetClass
    })
    return this.createAndPersistDevice(
      retained,
      name,
      scope,
      pairingReach,
      accessProfile,
      now + clampedTtlMs,
      budgetClass
    )
  }

  // Why persist before the memory swap: a failed write must not leave the bind decision reading a
  // reach that never reached disk. The caller always passes a row it just found in `this.devices`
  // (S10-16 C1 review finding 10), so the not-found branch is unreachable in practice; it exists so
  // `withPairingReach`'s contract never needs a non-null assertion at this call site.
  private setPairingReach(existing: DeviceEntry, pairingReach: RuntimePairingReach): DeviceEntry {
    const nextDevices = withPairingReach(this.devices, existing.deviceId, pairingReach)
    if (!nextDevices) {
      return existing
    }
    this.save(nextDevices)
    this.devices = nextDevices
    return nextDevices.find((d) => d.deviceId === existing.deviceId) ?? existing
  }

  // Why: explicit rotation path for "Regenerate QR" — invalidates any existing never-scanned token
  // (e.g. one that was screenshotted, copied to clipboard, or shown on a screen-share) and mints a
  // fresh one. Without this, getOrCreatePendingDevice keeps returning the same token forever until a
  // phone actually pairs, so users have no way to revoke a leaked pre-pairing token.
  rotatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    accessProfile: 'full' | 'peer' = 'full',
    legacyGrantProfile: 'full' | 'peer' = 'full'
  ): DeviceEntry {
    // Why: rotation revokes the ONE shared token that may have been screenshotted; a minted invite is
    // named, individually revocable (mobile:revokeRuntimeAccess), and must survive an unrelated
    // "Regenerate" click — the desktop generator sends rotate on every unnamed link.
    // S10-19: never drop a sibling pending row minted under a DIFFERENT access profile — rotation
    // is scoped to the profile being regenerated, same discipline as the coalescing predicate.
    return this.createAndPersistDevice(
      rotateRetainedDevices(this.devices, scope, accessProfile, legacyGrantProfile),
      name,
      scope,
      pairingReach,
      accessProfile
    )
  }

  removeDevice(deviceId: string): boolean {
    const nextDevices = this.devices.filter((d) => d.deviceId !== deviceId)
    if (nextDevices.length === this.devices.length) {
      return false
    }
    // Why: persist before memory swap so a failed write does not drop a device
    // only in-process while disk still lists it (and vice versa on reload).
    this.save(nextDevices)
    this.devices = nextDevices
    return true
  }

  getDevice(deviceId: string): DeviceEntry | null {
    return this.devices.find((d) => d.deviceId === deviceId) ?? null
  }

  /**
   * The shared, regenerable pending row of a scope — never a minted named invite.
   * accessProfile, when given, narrows to a row of exactly that effective profile (S10-19); omitted
   * preserves every pre-existing caller's untargeted lookup.
   */
  getPendingDevice(
    scope: DeviceScope = 'mobile',
    accessProfile?: 'full' | 'peer',
    legacyGrantProfile: 'full' | 'peer' = 'full'
  ): DeviceEntry | null {
    return (
      this.devices.find(
        (device) =>
          device.lastSeenAt === 0 &&
          device.scope === scope &&
          !isMintedPendingDevice(device) &&
          (accessProfile === undefined ||
            effectiveAccessProfile(device, legacyGrantProfile) === accessProfile)
      ) ?? null
    )
  }

  setRelayBinding(deviceId: string, binding: RelayDeviceBinding): boolean {
    const nextDevices = withRelayBinding(this.devices, deviceId, binding)
    if (!nextDevices) {
      return false
    }
    this.save(nextDevices)
    this.devices = nextDevices
    return true
  }

  // Why persist before swapping memory: a failed write must not leave a mode the UI/runtime
  // believe was stored.
  setMobilePairingConnectionMode(deviceId: string, mode: MobilePairingConnectionMode): boolean {
    const nextDevices = withMobilePairingConnectionMode(this.devices, deviceId, mode)
    if (!nextDevices) {
      return false
    }
    this.save(nextDevices)
    this.devices = nextDevices
    return true
  }

  getMobilePairingConnectionMode(deviceId: string): MobilePairingConnectionMode | null {
    return readMobilePairingConnectionMode(this.devices, deviceId)
  }

  listDevices(): readonly DeviceEntry[] {
    return this.devices
  }

  validateToken(token: string): DeviceEntry | null {
    const device = this.devices.find((d) => d.token === token) ?? null
    // Why: the sweep only runs on load and on the next mint, so a headless serve that mints once at
    // startup would keep a stale invite usable for the whole process lifetime. The deadline has to bind
    // where the credential is consumed — this is the single authorization lookup for every socket.
    // S10-16 C1 review F1/F4: a legacy-sweep-stamped row carries no pendingExpiresAt (isExpiredPendingDevice
    // never matches it), so its own deadline check is a second, independent clause — never deleted at
    // load, refused here instead once past pairedAt + PENDING_GRANT_TTL_MS.
    const now = Date.now()
    return device &&
      (isExpiredPendingDevice(device, now) || isExpiredLegacyCoalescedGrant(device, now))
      ? null
      : device
  }

  // Why persist before memory swap: a failed write must not leave a scanned device looking
  // never-scanned on disk, where rotation would drop it.
  updateLastSeen(deviceId: string): void {
    const nextDevices = withLastSeenAt(this.devices, deviceId, Date.now())
    if (!nextDevices) {
      return
    }
    this.save(nextDevices)
    this.devices = nextDevices
    this.lastSeenFlush.cancel()
  }

  // Marks a device seen without blocking the caller on disk — the E2EE auth handshake runs this,
  // and on Windows every save spawns PowerShell synchronously to reapply the registry's ACL. The
  // first-ever sighting still persists inline: rotatePendingDevice drops entries that disk says
  // were never scanned, so only that 0 -> non-zero transition is load-bearing.
  updateLastSeenDeferred(deviceId: string): void {
    const device = this.devices.find((d) => d.deviceId === deviceId)
    if (!device) {
      return
    }
    if (device.lastSeenAt === 0) {
      this.updateLastSeen(deviceId)
      return
    }
    this.devices = withLastSeenAt(this.devices, deviceId, Date.now()) ?? this.devices
    this.lastSeenFlush.schedule()
  }

  /** Persists a deferred lastSeen refresh now; no-op when nothing is pending. */
  flushPendingLastSeen(): void {
    if (!this.lastSeenFlush.pending) {
      return
    }
    this.lastSeenFlush.cancel()
    try {
      this.save(this.devices)
    } catch (error) {
      // Why: matches the async hardening path — a failed bookkeeping write must not take down the runtime.
      console.error('[mobile] Failed to persist device lastSeen:', error)
    }
  }

  /**
   * Whether the on-disk registry was actually read; false after a load failure. NOT sufficient on
   * its own to authorize a destructive sweep — §2a gates orphan reconciliation on this flag AND a
   * non-empty registry, because a missing file also reports true (a transient existsSync miss
   * during a secure-file replace can produce that). Read it as "the zero devices below are not the
   * result of a caught throw", never as "the device list is authoritative".
   */
  get loadSucceeded(): boolean {
    return this.registryLoadSucceeded
  }

  // Read/normalize/sweep is a pure function in device-registry-load.ts; this owns state assignment.
  private load(): void {
    const { devices, loadSucceeded, legacySweepAudit } = loadDeviceRegistryFile(this.registryPath)
    this.devices = devices
    this.registryLoadSucceeded = loadSucceeded
    this.pendingLegacySweepAudit.push(...legacySweepAudit)
    // S10-16 C1 review round 2 D2: a headless `orca serve` that never touches an orchestration verb
    // never constructs the DB, so these rows could otherwise sit here until process exit and vanish
    // with no trace (getPendingLegacySweepAudit/flushLegacySweepAudit still drain them the moment a
    // DB does attach — this is loud degradation, not a behavior change).
    if (legacySweepAudit.length > 0) {
      console.warn(
        `[mobile] Legacy-sweep audit: ${legacySweepAudit.length} row(s) queued at registry load; ` +
          'will flush once the orchestration DB attaches.'
      )
    }
  }

  /** Drains and returns the legacy-sweep audit rows this load produced, if any (S10-16 R1.4). */
  getPendingLegacySweepAudit(): LegacySweepAuditRow[] {
    const drained = this.pendingLegacySweepAudit
    this.pendingLegacySweepAudit = []
    return drained
  }

  private save(devices: DeviceEntry[]): void {
    writeSecureJsonFile(this.registryPath, devices)
    // Why: every registry save includes the latest in-memory timestamps, so a later timer would rewrite it.
    this.lastSeenFlush.cancel()
  }
}
