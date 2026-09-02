// Why: per-device tokens replace the shared runtime auth token for WebSocket
// (mobile) connections. Each paired device gets its own revocable token so
// compromising one device doesn't expose others. The registry is a simple
// JSON file with hardened permissions matching the runtime metadata pattern.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import type { DeviceScope } from '../../shared/runtime-types'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import {
  MAX_LIVE_MINTED_GRANTS,
  PENDING_GRANT_TTL_MS,
  isExpiredPendingDevice,
  isMintedPendingDevice,
  retainNewestMintedGrants,
  retainUnexpiredPendingDevices
} from './device-registry-pending-grants'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import {
  effectiveAccessProfile,
  normalizeLoadedDeviceEntryFields
} from './device-registry-field-normalizers'

export { effectiveAccessProfile }

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
  // S10-19: the least-privilege peer access profile this grant was minted under. Absent means
  // "minted before this slice existed" — effectiveAccessProfile() resolves that case against the
  // host's legacyGrantProfile config (ships 'full'), which is the install-day no-op property.
  accessProfile?: 'full' | 'peer'
}

// Why: a lastSeen refresh is pure bookkeeping, so coalesce reconnect bursts into one write instead of
// paying a secure-file rewrite (two synchronous PowerShell ACL spawns on Windows) per connection.
const LAST_SEEN_FLUSH_DELAY_MS = 250

export class DeviceRegistry {
  private readonly registryPath: string
  private devices: DeviceEntry[] = []
  private pendingLastSeenFlush: NodeJS.Timeout | null = null
  // Why: a failed load yields zero devices, which any "delete what no device claims" sweep
  // would read as "delete everything". Only a completed read/normalize sets this.
  private registryLoadSucceeded = false

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

  private createAndPersistDevice(
    existingDevices: DeviceEntry[],
    name: string,
    scope: DeviceScope,
    pairingReach: RuntimePairingReach,
    // R10: always written, never omitted — unlike pendingExpiresAt, a missing accessProfile on a
    // freshly-minted row would be indistinguishable from a pre-S10-19 legacy grant.
    accessProfile: 'full' | 'peer' = 'full',
    pendingExpiresAt?: number
  ): DeviceEntry {
    const entry: DeviceEntry = {
      deviceId: randomUUID(),
      name,
      token: randomBytes(24).toString('hex'),
      scope,
      pairedAt: Date.now(),
      lastSeenAt: 0,
      pairingReach,
      accessProfile,
      // Why: omit the key entirely when absent so a coalesced grant's persisted shape is unchanged.
      ...(pendingExpiresAt === undefined ? {} : { pendingExpiresAt })
    }
    const nextDevices = [...existingDevices, entry]
    // Why: a credential is not valid until its durable registry write succeeds.
    this.save(nextDevices)
    this.devices = nextDevices
    return entry
  }

  // Why: coalesce repeated QR-regenerate clicks onto a single pending token.
  // Each call to addDevice() produces a valid auth credential; without
  // coalescing, every renderer call to mobile:getPairingQR (e.g. the new
  // copy-button flow that encourages regeneration) leaves an orphaned token
  // forever. Returns an existing never-scanned entry if present; otherwise
  // mints a new one and drops any stale pending entries.
  getOrCreatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    accessProfile: 'full' | 'peer' = 'full',
    // Why: resolves a legacy (pre-S10-19) pending row's effective profile for the coalescing
    // comparison below; the host's legacyGrantProfile config, ships 'full'.
    legacyGrantProfile: 'full' | 'peer' = 'full'
  ): DeviceEntry {
    // Why: a minted row carries a deadline and belongs to one named human, so reusing it here would hand
    // that person's link out again as the shared unnamed one. The two lanes stay disjoint by construction.
    // S10-19: a pending row coalesces only within its own access profile — a peer-scoped pending
    // link must never silently widen into (or be silently narrowed from) a full-access one.
    const existing = this.devices.find(
      (d) =>
        d.lastSeenAt === 0 &&
        d.scope === scope &&
        !isMintedPendingDevice(d) &&
        effectiveAccessProfile(d, legacyGrantProfile) === accessProfile
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

  // Why: two humans handed one coalesced link land on one deviceId and one token, so nothing downstream
  // can tell them apart. A grant can only be split per person at offer time, so this path mints a fresh
  // row on every call and never reuses a pending one. Unlike rotatePendingDevice it keeps sibling pending
  // rows, so minting Ben's invite cannot kill Ana's un-scanned one.
  mintPendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    // Why clamped to (0, PENDING_GRANT_TTL_MS] rather than accepted verbatim: an invite can only be
    // SHORTENED, never extended past the design's leak control (S9 §2a's 24h ceiling).
    ttlMs?: number,
    accessProfile: 'full' | 'peer' = 'full'
  ): DeviceEntry {
    const now = Date.now()
    const clampedTtlMs =
      ttlMs !== undefined && Number.isFinite(ttlMs)
        ? Math.min(Math.max(ttlMs, 1), PENDING_GRANT_TTL_MS)
        : PENDING_GRANT_TTL_MS
    return this.createAndPersistDevice(
      // Why: the cap leaves room for the row about to be appended, so no window ever holds more than
      // MAX_LIVE_MINTED_GRANTS live invites no matter how often the renderer regenerates.
      retainNewestMintedGrants(
        retainUnexpiredPendingDevices(this.devices, now),
        MAX_LIVE_MINTED_GRANTS - 1
      ),
      name,
      scope,
      pairingReach,
      accessProfile,
      now + clampedTtlMs
    )
  }

  private setPairingReach(existing: DeviceEntry, pairingReach: RuntimePairingReach): DeviceEntry {
    const updated: DeviceEntry = { ...existing, pairingReach }
    const nextDevices = this.devices.map((device) =>
      device.deviceId === existing.deviceId ? updated : device
    )
    // Why: persist before the memory swap so a failed write cannot leave the bind decision reading a
    // reach that never reached disk.
    this.save(nextDevices)
    this.devices = nextDevices
    return updated
  }

  // Why: explicit rotation path for "Regenerate QR" — invalidates any
  // existing never-scanned token (e.g. one that was screenshotted, copied
  // to clipboard, or shown on a screen-share) and mints a fresh one. Without
  // this, getOrCreatePendingDevice keeps returning the same token forever
  // until a phone actually pairs, so users have no way to revoke a leaked
  // pre-pairing token.
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
    const retainedDevices = this.devices.filter(
      (d) =>
        d.lastSeenAt !== 0 ||
        d.scope !== scope ||
        isMintedPendingDevice(d) ||
        effectiveAccessProfile(d, legacyGrantProfile) !== accessProfile
    )
    return this.createAndPersistDevice(retainedDevices, name, scope, pairingReach, accessProfile)
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
    const index = this.devices.findIndex((candidate) => candidate.deviceId === deviceId)
    if (index === -1 || binding.relayDeviceId !== deviceId) {
      return false
    }
    const nextDevices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? { ...device, relayBinding: binding } : device
    )
    this.save(nextDevices)
    this.devices = nextDevices
    return true
  }

  setMobilePairingConnectionMode(deviceId: string, mode: MobilePairingConnectionMode): boolean {
    const index = this.devices.findIndex((candidate) => candidate.deviceId === deviceId)
    if (index === -1 || this.devices[index]?.scope !== 'mobile') {
      return false
    }
    // Why: persist before swapping memory so a failed write does not leave a
    // mode the UI/runtime believe was stored.
    const nextDevices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? { ...device, mobilePairingConnectionMode: mode } : device
    )
    this.save(nextDevices)
    this.devices = nextDevices
    return true
  }

  getMobilePairingConnectionMode(deviceId: string): MobilePairingConnectionMode | null {
    const device = this.devices.find((candidate) => candidate.deviceId === deviceId)
    if (!device || device.scope !== 'mobile') {
      return null
    }
    // Why: pairings created before this preference existed used automatic
    // direct-first Relay fallback, so missing state must preserve that behavior.
    return device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic'
  }

  listDevices(): readonly DeviceEntry[] {
    return this.devices
  }

  validateToken(token: string): DeviceEntry | null {
    const device = this.devices.find((d) => d.token === token) ?? null
    // Why: the sweep only runs on load and on the next mint, so a headless serve that mints once at
    // startup would keep a stale invite usable for the whole process lifetime. The deadline has to bind
    // where the credential is consumed — this is the single authorization lookup for every socket.
    return device && isExpiredPendingDevice(device, Date.now()) ? null : device
  }

  updateLastSeen(deviceId: string): void {
    const index = this.devices.findIndex((d) => d.deviceId === deviceId)
    if (index === -1) {
      return
    }
    // Why: persist before memory swap so a failed write cannot leave a scanned
    // device looking never-scanned on disk, where rotation would drop it.
    const seenAt = Date.now()
    const nextDevices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? { ...device, lastSeenAt: seenAt } : device
    )
    this.save(nextDevices)
    this.devices = nextDevices
    this.cancelPendingLastSeenFlush()
  }

  /**
   * Marks a device seen without blocking the caller on disk — the E2EE auth handshake runs this, and on
   * Windows every save spawns PowerShell synchronously to reapply the registry's ACL.
   * The first-ever sighting still persists inline: rotatePendingDevice drops entries that disk says were
   * never scanned, so only that 0 -> non-zero transition is load-bearing.
   */
  updateLastSeenDeferred(deviceId: string): void {
    const index = this.devices.findIndex((d) => d.deviceId === deviceId)
    if (index === -1) {
      return
    }
    if (this.devices[index]!.lastSeenAt === 0) {
      this.updateLastSeen(deviceId)
      return
    }
    const seenAt = Date.now()
    this.devices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? { ...device, lastSeenAt: seenAt } : device
    )
    if (this.pendingLastSeenFlush) {
      return
    }
    this.pendingLastSeenFlush = setTimeout(
      () => this.flushPendingLastSeen(),
      LAST_SEEN_FLUSH_DELAY_MS
    )
    // Why: bookkeeping must never hold the process open.
    this.pendingLastSeenFlush.unref?.()
  }

  /** Persists a deferred lastSeen refresh now; no-op when nothing is pending. */
  flushPendingLastSeen(): void {
    if (!this.pendingLastSeenFlush) {
      return
    }
    this.cancelPendingLastSeenFlush()
    try {
      this.save(this.devices)
    } catch (error) {
      // Why: matches the async hardening path — a failed bookkeeping write must not take down the runtime.
      console.error('[mobile] Failed to persist device lastSeen:', error)
    }
  }

  private cancelPendingLastSeenFlush(): void {
    if (this.pendingLastSeenFlush) {
      clearTimeout(this.pendingLastSeenFlush)
      this.pendingLastSeenFlush = null
    }
  }

  /**
   * Whether the on-disk registry was actually read; false after a load failure.
   *
   * NOT sufficient on its own to authorize a destructive sweep. §2a gates orphan
   * reconciliation on this flag AND a non-empty registry, because a missing file also
   * reports true — which a transient existsSync miss during a secure-file replace can
   * produce. Read it as "the zero devices below are not the result of a caught throw",
   * never as "the device list is authoritative".
   */
  get loadSucceeded(): boolean {
    return this.registryLoadSucceeded
  }

  private load(): void {
    if (!existsSync(this.registryPath)) {
      // Why: no file is an authoritative empty registry, not a failed read.
      this.devices = []
      this.registryLoadSucceeded = true
      return
    }
    try {
      hardenExistingSecureFile(this.registryPath)
      const parsed = JSON.parse(readFileSync(this.registryPath, 'utf-8')) as DeviceEntry[]
      const loaded: DeviceEntry[] = parsed.map((device) => ({
        ...device,
        ...normalizeLoadedDeviceEntryFields(device)
      }))
      // Why: sweep in memory only — the next mutation persists the pruned array, and rewriting here would
      // pay a secure-file write (two synchronous PowerShell ACL spawns on Windows) on every construction.
      this.devices = retainUnexpiredPendingDevices(loaded, Date.now())
      this.registryLoadSucceeded = true
    } catch {
      this.devices = []
      this.registryLoadSucceeded = false
    }
  }

  private save(devices: DeviceEntry[]): void {
    writeSecureJsonFile(this.registryPath, devices)
    // Why: every registry save includes the latest in-memory timestamps, so a later timer would rewrite it.
    this.cancelPendingLastSeenFlush()
  }
}
