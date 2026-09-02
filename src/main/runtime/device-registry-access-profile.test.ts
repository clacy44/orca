// S10-19 (chair rulings 20/22/24, §7.3): DeviceRegistry.accessProfile field, effectiveAccessProfile(),
// and the install-day no-op property (S-4/NEG-9/S-6).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeviceRegistry, effectiveAccessProfile, type DeviceEntry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

describe('S10-19: effectiveAccessProfile', () => {
  it('device.accessProfile wins when present', () => {
    expect(effectiveAccessProfile({ accessProfile: 'peer' }, 'full')).toBe('peer')
    expect(effectiveAccessProfile({ accessProfile: 'full' }, 'peer')).toBe('full')
  })

  it('falls back to legacyGrantProfile when accessProfile is absent (S-4: the install-day no-op)', () => {
    expect(effectiveAccessProfile({ accessProfile: undefined }, 'full')).toBe('full')
    expect(effectiveAccessProfile({ accessProfile: undefined }, 'peer')).toBe('peer')
  })
})

describe('S10-19: DeviceRegistry access-profile plumbing (S-4/S-6/NEG-9)', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-registry-profile-'))
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

  it('S-4 (install-day no-op): addDevice with no accessProfile argument always writes accessProfile:"full"', () => {
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.addDevice('Ana', 'runtime')
    expect(device.accessProfile).toBe('full')
    const persisted = readRegistryFile()
    expect(persisted[0]?.accessProfile).toBe('full')
  })

  it('mintPendingDevice threads an explicit accessProfile through to the persisted row', () => {
    const registry = new DeviceRegistry(userDataPath)
    const peerDevice = registry.mintPendingDevice(
      'Peer Worker',
      'runtime',
      'network',
      undefined,
      'peer'
    )
    expect(peerDevice.accessProfile).toBe('peer')
    const fullDevice = registry.mintPendingDevice('Full Op', 'runtime')
    expect(fullDevice.accessProfile).toBe('full')
    const persisted = readRegistryFile()
    expect(persisted.find((d) => d.deviceId === peerDevice.deviceId)?.accessProfile).toBe('peer')
    expect(persisted.find((d) => d.deviceId === fullDevice.deviceId)?.accessProfile).toBe('full')
  })

  it('the coalescing pending row is scoped per access profile: a peer pending grant never coalesces with a full one', () => {
    const registry = new DeviceRegistry(userDataPath)
    const fullPending = registry.getOrCreatePendingDevice(
      'CLI',
      'runtime',
      'network',
      'full',
      'full'
    )
    const peerPending = registry.getOrCreatePendingDevice(
      'CLI',
      'runtime',
      'network',
      'peer',
      'full'
    )
    expect(peerPending.deviceId).not.toBe(fullPending.deviceId)
    // Calling again with the same profile coalesces onto the same row.
    const fullAgain = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network', 'full', 'full')
    expect(fullAgain.deviceId).toBe(fullPending.deviceId)
    const peerAgain = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network', 'peer', 'full')
    expect(peerAgain.deviceId).toBe(peerPending.deviceId)
  })

  it('rotatePendingDevice never drops a sibling pending row minted under a different access profile', () => {
    const registry = new DeviceRegistry(userDataPath)
    const peerPending = registry.getOrCreatePendingDevice(
      'CLI',
      'runtime',
      'network',
      'peer',
      'full'
    )
    // Rotating the full-profile pending lane must not touch the peer one.
    registry.rotatePendingDevice('CLI', 'runtime', 'network', 'full', 'full')
    expect(registry.getDevice(peerPending.deviceId)).not.toBeNull()
  })

  it('getPendingDevice narrows to a specific effective access profile when asked', () => {
    const registry = new DeviceRegistry(userDataPath)
    const peerPending = registry.getOrCreatePendingDevice(
      'CLI',
      'runtime',
      'network',
      'peer',
      'full'
    )
    const fullPending = registry.getOrCreatePendingDevice(
      'CLI',
      'runtime',
      'network',
      'full',
      'full'
    )
    expect(registry.getPendingDevice('runtime', 'peer', 'full')?.deviceId).toBe(
      peerPending.deviceId
    )
    expect(registry.getPendingDevice('runtime', 'full', 'full')?.deviceId).toBe(
      fullPending.deviceId
    )
  })

  it('NEG-9: load() normaliser — absent stays undefined, full/peer pass through, garbage fails CLOSED to peer', () => {
    const registry = new DeviceRegistry(userDataPath)
    const seed = registry.addDevice('Seed', 'runtime')
    writeRegistryFile([
      { ...seed, deviceId: 'dev_legacy_absent', accessProfile: undefined as unknown as 'full' },
      { ...seed, deviceId: 'dev_explicit_full', accessProfile: 'full' },
      { ...seed, deviceId: 'dev_explicit_peer', accessProfile: 'peer' },
      { ...seed, deviceId: 'dev_garbage_value', accessProfile: 'superuser' as unknown as 'full' }
    ])
    const reloaded = new DeviceRegistry(userDataPath)
    expect(reloaded.getDevice('dev_legacy_absent')?.accessProfile).toBeUndefined()
    expect(reloaded.getDevice('dev_explicit_full')?.accessProfile).toBe('full')
    expect(reloaded.getDevice('dev_explicit_peer')?.accessProfile).toBe('peer')
    // Fail-closed: an unrecognized value on disk is never trusted as 'full'.
    expect(reloaded.getDevice('dev_garbage_value')?.accessProfile).toBe('peer')
  })
})
