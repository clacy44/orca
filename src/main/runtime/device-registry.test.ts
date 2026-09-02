import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry, type DeviceEntry } from './device-registry'
import { MAX_LIVE_MINTED_GRANTS, PENDING_GRANT_TTL_MS } from './device-registry-pending-grants'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

const DAY_MS = 24 * 60 * 60 * 1000

describe('DeviceRegistry pending grants', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-registry-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  const registryFilePath = (): string => join(userDataPath, DEVICE_REGISTRY_FILENAME)

  const readRegistryFile = (): DeviceEntry[] =>
    JSON.parse(readFileSync(registryFilePath(), 'utf-8')) as DeviceEntry[]

  const writeRegistryFile = (devices: DeviceEntry[]): void => {
    writeFileSync(registryFilePath(), JSON.stringify(devices), 'utf-8')
  }

  it('mints a distinct grant per call in the same scope', () => {
    const registry = new DeviceRegistry(userDataPath)

    const ana = registry.mintPendingDevice('Ana', 'runtime')
    const ben = registry.mintPendingDevice('Ben', 'runtime')

    expect(ana.deviceId).not.toBe(ben.deviceId)
    expect(ana.token).not.toBe(ben.token)
    // The gate: two humans scanning two links land two distinct pairedDeviceIds on one runtime, and the
    // registry file — not just memory — is what proves it.
    const persisted = readRegistryFile()
    expect(persisted.map((device) => device.deviceId)).toEqual([ana.deviceId, ben.deviceId])
    expect(persisted.map((device) => device.name)).toEqual(['Ana', 'Ben'])
    expect(new Set(persisted.map((device) => device.token)).size).toBe(2)
  })

  it('keeps sibling pending rows when minting and never lets one leak into the shared lane', () => {
    const registry = new DeviceRegistry(userDataPath)

    const ana = registry.mintPendingDevice('Ana', 'runtime')
    const ben = registry.mintPendingDevice('Ben', 'runtime')

    expect(registry.getDevice(ana.deviceId)).not.toBeNull()

    // The lane fence: an unnamed `orca serve` must never re-advertise a named person's invite.
    const coalesced = registry.getOrCreatePendingDevice('Unnamed', 'runtime')
    expect(coalesced.deviceId).not.toBe(ana.deviceId)
    expect(coalesced.deviceId).not.toBe(ben.deviceId)
    expect(coalesced.pendingExpiresAt).toBeUndefined()
    // Same fence for the mobile QR flow, which reads the shared pending row directly.
    expect(registry.getPendingDevice('runtime')?.deviceId).toBe(coalesced.deviceId)

    // Negative control on the path S1 must not disturb: two unnamed calls still coalesce onto one row.
    expect(registry.getOrCreatePendingDevice('Unnamed', 'runtime').deviceId).toBe(
      coalesced.deviceId
    )
  })

  it('hides minted rows from the mobile pending lookup', () => {
    const registry = new DeviceRegistry(userDataPath)

    const minted = registry.mintPendingDevice('Ana', 'mobile')

    // Why it matters: createMobilePairingOfferSerial binds a Relay invite onto whatever getPendingDevice
    // returns, so a named grant surfacing here would take a cloud credential meant for someone else.
    expect(registry.getPendingDevice('mobile')).toBeNull()
    expect(registry.getDevice(minted.deviceId)).not.toBeNull()
  })

  it('stamps a 24h deadline on minted rows and leaves coalesced rows without one', () => {
    const registry = new DeviceRegistry(userDataPath)
    const before = Date.now()

    const minted = registry.mintPendingDevice('Ana', 'runtime')
    const coalesced = registry.getOrCreatePendingDevice('Coalesced', 'mobile')

    expect(minted.pendingExpiresAt).toBeGreaterThanOrEqual(before + DAY_MS)
    expect(minted.pendingExpiresAt).toBeLessThanOrEqual(Date.now() + DAY_MS)
    expect(coalesced.pendingExpiresAt).toBeUndefined()
    // Byte-shape control: the coalesced row's persisted keys are exactly today's set.
    const persistedCoalesced = readRegistryFile().find(
      (device) => device.deviceId === coalesced.deviceId
    )
    expect(Object.keys(persistedCoalesced ?? {}).sort()).toEqual([
      'deviceId',
      'lastSeenAt',
      'name',
      'pairedAt',
      'pairingReach',
      'scope',
      'token'
    ])
  })

  it('sweeps expired never-connected minted rows and keeps unexpired ones', () => {
    const now = Date.now()
    writeRegistryFile([
      {
        deviceId: 'expired',
        name: 'Ana',
        token: 'expired-token',
        scope: 'runtime',
        pairedAt: now - 2 * DAY_MS,
        lastSeenAt: 0,
        pendingExpiresAt: now - 1_000
      },
      {
        deviceId: 'fresh',
        name: 'Ben',
        token: 'fresh-token',
        scope: 'runtime',
        pairedAt: now,
        lastSeenAt: 0,
        pendingExpiresAt: now + DAY_MS
      }
    ])

    const registry = new DeviceRegistry(userDataPath)

    expect(registry.getDevice('expired')).toBeNull()
    expect(registry.validateToken('expired-token')).toBeNull()
    expect(registry.getDevice('fresh')).not.toBeNull()

    // The sweep also runs on the mint path, and the pruned array is what reaches disk.
    registry.mintPendingDevice('Cara', 'runtime')
    expect(readRegistryFile().map((device) => device.deviceId)).toEqual([
      'fresh',
      expect.any(String)
    ])
  })

  it('never sweeps an expired-looking row that has already connected', () => {
    const now = Date.now()
    writeRegistryFile([
      {
        deviceId: 'scanned',
        name: 'Ana',
        token: 'scanned-token',
        scope: 'runtime',
        pairedAt: now - 2 * DAY_MS,
        lastSeenAt: now - DAY_MS,
        pendingExpiresAt: now - 1_000
      }
    ])

    const registry = new DeviceRegistry(userDataPath)

    expect(registry.getDevice('scanned')).not.toBeNull()
    registry.mintPendingDevice('Ben', 'runtime')
    expect(readRegistryFile().some((device) => device.deviceId === 'scanned')).toBe(true)
  })

  // S10-16 R1.4: superseded. Before R1.4 this exact row (a pre-existing un-consumed COALESCED
  // runtime grant) was stranded forever with no revocation path — R1.4 exists precisely to close
  // that gap by giving it the PENDING_GRANT_TTL_MS deadline it should always have had, derived from
  // its own pairedAt (never `now`, protocol M7). Coverage for the "stamp survives an upgrade and is
  // byte-identical across constructions" property moved to device-registry-legacy-sweep.test.ts.
  //
  // S10-16 C1 review F1/F4: the sweep no longer deletes the row (it is KEPT and listable, refused
  // only at validateToken) and no longer writes pendingExpiresAt (grantClass carries the
  // classification instead) — restored to the design's stated behaviour (v6:775-786).
  it('stamps a legacy row written before pendingExpiresAt existed with a deadline derived from its own pairedAt (R1.4)', () => {
    writeRegistryFile([
      {
        deviceId: 'legacy',
        name: 'Legacy link',
        token: 'legacy-token',
        scope: 'runtime',
        pairedAt: 0,
        lastSeenAt: 0
      }
    ])

    const registry = new DeviceRegistry(userDataPath)

    // pairedAt: 0 is far older than PENDING_GRANT_TTL_MS before "now" — the stamped deadline is
    // already in the past, so validateToken refuses it on next use. Loud AND kept: the sweep
    // recorded the audit row (getPendingLegacySweepAudit) and the row itself stays on disk and
    // listable — design v6:781-786, not deleted.
    const device = registry.getDevice('legacy')
    expect(device).not.toBeNull()
    expect(device?.grantClass).toBe('legacy_coalesced')
    expect(device?.pendingExpiresAt).toBeUndefined()
    expect(registry.validateToken('legacy-token')).toBeNull()
    expect(registry.getPendingLegacySweepAudit()).toEqual([
      {
        deviceId: 'legacy',
        name: 'Legacy link',
        pairedAt: 0,
        legacyExpiresAt: PENDING_GRANT_TTL_MS
      }
    ])

    registry.mintPendingDevice('Ana', 'runtime')
    const persisted = readRegistryFile()
    expect(persisted.map((device) => device.deviceId)).toEqual(['legacy', expect.any(String)])
  })

  it('F2: rotatePendingDevice still removes a legacy_coalesced row the sweep stamped (one-click revocation restored)', () => {
    writeRegistryFile([
      {
        deviceId: 'legacy-runtime',
        name: 'Legacy runtime link',
        token: 'legacy-runtime-token',
        scope: 'runtime',
        pairedAt: Date.now(),
        lastSeenAt: 0
      }
    ])

    const registry = new DeviceRegistry(userDataPath)
    expect(registry.getDevice('legacy-runtime')?.grantClass).toBe('legacy_coalesced')

    registry.rotatePendingDevice('Rotated', 'runtime')

    // Design v6:761-763's premise (a swept row is never reachable by a runtime-scope rotate) was
    // wrong at c314fa5d52 (finding 2) — F1's grantClass fix restores the one-click revocation path.
    expect(registry.getDevice('legacy-runtime')).toBeNull()
  })

  it('rotatePendingDevice drops the shared pending row but spares named invites', () => {
    const registry = new DeviceRegistry(userDataPath)

    const ana = registry.mintPendingDevice('Ana', 'runtime')
    const phone = registry.mintPendingDevice('Phone', 'mobile')
    const scanned = registry.mintPendingDevice('Scanned', 'runtime')
    registry.updateLastSeen(scanned.deviceId)
    const shared = registry.getOrCreatePendingDevice('Shared', 'runtime')

    const rotated = registry.rotatePendingDevice('Rotated', 'runtime')

    // Negative control: rotate still kills the one shared, possibly-screenshotted token of its scope...
    expect(registry.getDevice(shared.deviceId)).toBeNull()
    // ...and nothing else. A named invite is separately revocable, so an unrelated "Regenerate" click in
    // Settings (which always rotates) must not silently invalidate every `serve --pair-name` grant.
    expect(registry.getDevice(ana.deviceId)).not.toBeNull()
    expect(registry.getDevice(scanned.deviceId)).not.toBeNull()
    expect(registry.getDevice(phone.deviceId)).not.toBeNull()
    expect(registry.getDevice(rotated.deviceId)).not.toBeNull()
    expect(rotated.pendingExpiresAt).toBeUndefined()
  })

  it('refuses an expired minted token at validation even when no sweep has run', () => {
    vi.useFakeTimers()
    try {
      const registry = new DeviceRegistry(userDataPath)
      const minted = registry.mintPendingDevice('Ana', 'runtime')
      const shared = registry.getOrCreatePendingDevice('Shared', 'runtime')
      const scanned = registry.mintPendingDevice('Scanned', 'runtime')
      registry.updateLastSeen(scanned.deviceId)

      expect(registry.validateToken(minted.token)?.deviceId).toBe(minted.deviceId)

      // A headless serve mints once at startup and never mints again, so nothing sweeps this row for the
      // rest of the process. The deadline has to bind where the credential is consumed.
      vi.setSystemTime(Date.now() + DAY_MS + 1_000)

      expect(registry.validateToken(minted.token)).toBeNull()
      // Negative controls: neither a deadline-free shared row nor an already-scanned grant expires.
      expect(registry.validateToken(shared.token)?.deviceId).toBe(shared.deviceId)
      expect(registry.validateToken(scanned.token)?.deviceId).toBe(scanned.deviceId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an expired minted row that still holds a Relay binding', () => {
    const now = Date.now()
    writeRegistryFile([
      {
        deviceId: 'relay-bound',
        name: 'Ana',
        token: 'relay-bound-token',
        scope: 'mobile',
        pairedAt: now - 2 * DAY_MS,
        lastSeenAt: 0,
        pendingExpiresAt: now - 1_000,
        relayBinding: {
          relayHostId: 'host-1',
          relayDeviceId: 'relay-bound',
          ownerIdentityKey: 'owner-key'
        }
      }
    ])

    const registry = new DeviceRegistry(userDataPath)
    registry.mintPendingDevice('Ben', 'runtime')

    // Why the row survives both sweeps: it is the only key to a live cloud invite, and the sweep — unlike
    // revokeMobileDevice — cannot queue the durable Relay revoke first.
    expect(registry.getDevice('relay-bound')).not.toBeNull()
    expect(readRegistryFile().some((device) => device.deviceId === 'relay-bound')).toBe(true)
    // It is retained for revocation, not for use: an expired invite still fails validation.
    expect(registry.validateToken('relay-bound-token')).toBeNull()
  })

  it('caps how many live minted grants can accumulate per (scope, budgetClass) partition, ignoring scanned rows', () => {
    const registry = new DeviceRegistry(userDataPath)
    const scanned = registry.mintPendingDevice(
      'Scanned',
      'runtime',
      'network',
      undefined,
      'ui_named'
    )
    registry.updateLastSeen(scanned.deviceId)
    const shared = registry.getOrCreatePendingDevice('Shared', 'runtime')

    // S10-16 R1.1: the cap partitions by issuing lane — every real call site always names one, so
    // the capping test must too (an omitted budgetClass now means the un-evictable 'legacy' lane,
    // covered by the negative control below).
    const minted = Array.from({ length: MAX_LIVE_MINTED_GRANTS + 4 }, (_, index) =>
      registry.mintPendingDevice(`Person ${index}`, 'runtime', 'network', undefined, 'ui_named')
    )

    const live = registry
      .listDevices()
      .filter((device) => device.lastSeenAt === 0 && device.pendingExpiresAt !== undefined)
    expect(live).toHaveLength(MAX_LIVE_MINTED_GRANTS)
    // The oldest are the ones dropped, and the newest cap-worth survive.
    expect(registry.getDevice(minted[0]!.deviceId)).toBeNull()
    expect(registry.getDevice(minted.at(-1)!.deviceId)).not.toBeNull()
    // Negative control: rows outside the mint lane are never counted against or dropped by the cap.
    expect(registry.getDevice(scanned.deviceId)).not.toBeNull()
    expect(registry.getDevice(shared.deviceId)).not.toBeNull()
  })

  it('normalizes an unusable pendingExpiresAt on disk, then (S10-16 R1.4) the legacy sweep stamps a fresh deadline from pairedAt', () => {
    const pairedAt = Date.now()
    writeRegistryFile([
      {
        deviceId: 'text-deadline',
        name: 'Ana',
        token: 'text-deadline-token',
        scope: 'runtime',
        pairedAt,
        lastSeenAt: 0,
        pendingExpiresAt: 'soon' as unknown as number
      },
      {
        deviceId: 'nan-deadline',
        name: 'Ben',
        token: 'nan-deadline-token',
        scope: 'runtime',
        pairedAt,
        lastSeenAt: 0,
        pendingExpiresAt: Number.NaN
      }
    ])

    const registry = new DeviceRegistry(userDataPath)

    // Negative control on the normalization: a value no comparison can order must not crash and must
    // not silently become an instantly-expired grant. Before R1.4 it would then be immortal; R1.4
    // instead classifies it exactly like any other legacy row, with a deadline derived from its own
    // pairedAt — still valid now (pairedAt is fresh), no longer eternal. S10-16 C1 review F1: the
    // sweep classifies via `grantClass`, never by writing `pendingExpiresAt`.
    expect(registry.validateToken('text-deadline-token')?.deviceId).toBe('text-deadline')
    expect(registry.validateToken('nan-deadline-token')?.deviceId).toBe('nan-deadline')
    expect(registry.getDevice('text-deadline')?.grantClass).toBe('legacy_coalesced')
    expect(registry.getDevice('text-deadline')?.pendingExpiresAt).toBeUndefined()
    expect(registry.getDevice('nan-deadline')?.grantClass).toBe('legacy_coalesced')
    expect(registry.getDevice('nan-deadline')?.pendingExpiresAt).toBeUndefined()
    expect(registry.getPendingLegacySweepAudit()).toEqual([
      {
        deviceId: 'text-deadline',
        name: 'Ana',
        pairedAt,
        legacyExpiresAt: pairedAt + PENDING_GRANT_TTL_MS
      },
      {
        deviceId: 'nan-deadline',
        name: 'Ben',
        pairedAt,
        legacyExpiresAt: pairedAt + PENDING_GRANT_TTL_MS
      }
    ])
    registry.mintPendingDevice('Cara', 'runtime')
    expect(readRegistryFile().map((device) => device.deviceId)).toEqual([
      'text-deadline',
      'nan-deadline',
      expect.any(String)
    ])
    expect(readRegistryFile()[0]?.pendingExpiresAt).toBeUndefined()
    expect(readRegistryFile()[0]?.grantClass).toBe('legacy_coalesced')
  })

  it('mints with a caller-given ttlMs, clamped to at most the 24h default', () => {
    const registry = new DeviceRegistry(userDataPath)
    const now = Date.now()

    const shortened = registry.mintPendingDevice('Ana', 'runtime', 'network', 2 * 60 * 60 * 1000)
    expect(shortened.pendingExpiresAt).toBeGreaterThanOrEqual(now + 2 * 60 * 60 * 1000 - 1000)
    expect(shortened.pendingExpiresAt).toBeLessThanOrEqual(now + 2 * 60 * 60 * 1000 + 1000)

    // Why it can only shorten: an invite can never outlive the design's 24h leak-control ceiling.
    const tooLong = registry.mintPendingDevice('Ben', 'runtime', 'network', DAY_MS * 10)
    expect(tooLong.pendingExpiresAt).toBeLessThanOrEqual(now + DAY_MS + 1000)

    const omitted = registry.mintPendingDevice('Cy', 'runtime')
    expect(omitted.pendingExpiresAt).toBeGreaterThanOrEqual(now + DAY_MS - 1000)
  })
})

describe('DeviceRegistry load provenance', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-registry-load-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  const registryFilePath = (): string => join(userDataPath, DEVICE_REGISTRY_FILENAME)

  it('reports success for a readable registry', () => {
    writeFileSync(
      registryFilePath(),
      JSON.stringify([
        {
          deviceId: 'phone-1',
          name: 'Phone',
          token: 'token-1',
          scope: 'mobile',
          pairedAt: 1,
          lastSeenAt: 1
        }
      ]),
      'utf-8'
    )

    const registry = new DeviceRegistry(userDataPath)

    expect(registry.loadSucceeded).toBe(true)
    expect(registry.validateToken('token-1')?.deviceId).toBe('phone-1')
  })

  it('reports success for a registry that does not exist yet', () => {
    expect(new DeviceRegistry(userDataPath).loadSucceeded).toBe(true)
  })

  it('reports failure when the registry cannot be parsed', () => {
    writeFileSync(registryFilePath(), '{ not json', 'utf-8')

    const registry = new DeviceRegistry(userDataPath)

    // The gate: zero devices here means "unknown", not "none paired" — a later sweep must not
    // read it as permission to delete every lane on the host.
    expect(registry.loadSucceeded).toBe(false)
    expect(registry.listDevices()).toEqual([])
  })
})
