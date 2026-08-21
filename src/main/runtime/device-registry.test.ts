import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeviceRegistry, type DeviceEntry } from './device-registry'
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

  it('keeps sibling pending rows when minting, unlike getOrCreatePendingDevice which reuses one', () => {
    const registry = new DeviceRegistry(userDataPath)

    const first = registry.mintPendingDevice('Ana', 'runtime')
    registry.mintPendingDevice('Ben', 'runtime')

    expect(registry.getDevice(first.deviceId)).not.toBeNull()

    // Negative control on the path S1 must not disturb: coalescing still returns the first pending row.
    const coalesced = registry.getOrCreatePendingDevice('Ignored', 'runtime')
    expect(coalesced.deviceId).toBe(first.deviceId)
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

  it('rotatePendingDevice still drops sibling pending rows of its scope', () => {
    const registry = new DeviceRegistry(userDataPath)

    const ana = registry.mintPendingDevice('Ana', 'runtime')
    const phone = registry.mintPendingDevice('Phone', 'mobile')
    const scanned = registry.mintPendingDevice('Scanned', 'runtime')
    registry.updateLastSeen(scanned.deviceId)

    const rotated = registry.rotatePendingDevice('Rotated', 'runtime')

    // Negative control: rotate is unchanged — it still kills every un-scanned row of its own scope.
    expect(registry.getDevice(ana.deviceId)).toBeNull()
    expect(registry.getDevice(scanned.deviceId)).not.toBeNull()
    expect(registry.getDevice(phone.deviceId)).not.toBeNull()
    expect(registry.getDevice(rotated.deviceId)).not.toBeNull()
    expect(rotated.pendingExpiresAt).toBeUndefined()
  })
})
