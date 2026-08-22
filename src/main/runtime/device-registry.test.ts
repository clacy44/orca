import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry, type DeviceEntry } from './device-registry'
import { MAX_LIVE_MINTED_GRANTS } from './device-registry-pending-grants'
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

  it('never sweeps legacy rows written before pendingExpiresAt existed', () => {
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

    expect(registry.getDevice('legacy')).not.toBeNull()
    expect(registry.validateToken('legacy-token')?.deviceId).toBe('legacy')

    registry.mintPendingDevice('Ana', 'runtime')
    const persisted = readRegistryFile()
    expect(persisted.map((device) => device.deviceId)).toEqual(['legacy', expect.any(String)])
    // An upgrade must not add a deadline to a link already handed out.
    expect(persisted[0]).not.toHaveProperty('pendingExpiresAt')
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

  it('caps how many live minted grants can accumulate, ignoring scanned rows', () => {
    const registry = new DeviceRegistry(userDataPath)
    const scanned = registry.mintPendingDevice('Scanned', 'runtime')
    registry.updateLastSeen(scanned.deviceId)
    const shared = registry.getOrCreatePendingDevice('Shared', 'runtime')

    const minted = Array.from({ length: MAX_LIVE_MINTED_GRANTS + 4 }, (_, index) =>
      registry.mintPendingDevice(`Person ${index}`, 'runtime')
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

  it('treats an unusable pendingExpiresAt on disk as a never-expiring legacy row', () => {
    writeRegistryFile([
      {
        deviceId: 'text-deadline',
        name: 'Ana',
        token: 'text-deadline-token',
        scope: 'runtime',
        pairedAt: 0,
        lastSeenAt: 0,
        pendingExpiresAt: 'soon' as unknown as number
      },
      {
        deviceId: 'nan-deadline',
        name: 'Ben',
        token: 'nan-deadline-token',
        scope: 'runtime',
        pairedAt: 0,
        lastSeenAt: 0,
        pendingExpiresAt: Number.NaN
      }
    ])

    const registry = new DeviceRegistry(userDataPath)

    // Negative control on the normalization: a value no comparison can order must not silently become an
    // instantly-expired grant, nor an immortal one that pins the row forever.
    expect(registry.validateToken('text-deadline-token')?.deviceId).toBe('text-deadline')
    expect(registry.validateToken('nan-deadline-token')?.deviceId).toBe('nan-deadline')
    registry.mintPendingDevice('Cara', 'runtime')
    expect(readRegistryFile().map((device) => device.deviceId)).toEqual([
      'text-deadline',
      'nan-deadline',
      expect.any(String)
    ])
    expect(readRegistryFile()[0]).not.toHaveProperty('pendingExpiresAt')
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
