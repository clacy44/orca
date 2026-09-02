// S10-16 R1.4: the one-time legacy sweep that gives a pre-existing un-consumed coalesced runtime
// grant the deadline it should always have had — before R1, such a row (lastSeenAt===0, no
// pendingExpiresAt) is unreachable by rotatePendingDevice/retainNewestMintedGrants/
// retainUnexpiredPendingDevices and accepted forever by validateToken, a stranded bearer credential.
//
// S10-16 C1 review F1/F4: the sweep never writes `pendingExpiresAt` (INV-P-010 stays "written only
// by mintPendingDevice") — it stamps `grantClass: 'legacy_coalesced'` + `legacySweptAt` instead, and
// an already-past-deadline row is KEPT (never deleted by the sweep), refused only at validateToken.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry, type DeviceEntry } from './device-registry'
import { PENDING_GRANT_TTL_MS } from './device-registry-pending-grants'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

describe('DeviceRegistry legacy coalesced-grant sweep (R1.4)', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-registry-legacy-sweep-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  const registryFilePath = (): string => join(userDataPath, DEVICE_REGISTRY_FILENAME)

  const writeRegistryFile = (devices: DeviceEntry[]): void => {
    writeFileSync(registryFilePath(), JSON.stringify(devices), 'utf-8')
  }

  it('stamps a legacy coalesced runtime row on construction, with no mint ever called — never pendingExpiresAt (F1/INV-P-010)', () => {
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
    const device = registry.getDevice('legacy-runtime')
    const pairedAt = device!.pairedAt

    expect(device?.grantClass).toBe('legacy_coalesced')
    expect(device?.legacySweptAt).toBeDefined()
    // F1: the sweep must NEVER write pendingExpiresAt — that field is minted-grant-only evidence.
    expect(device?.pendingExpiresAt).toBeUndefined()
    expect(registry.getPendingLegacySweepAudit()).toEqual([
      {
        deviceId: 'legacy-runtime',
        name: 'Legacy runtime link',
        pairedAt,
        legacyExpiresAt: pairedAt + PENDING_GRANT_TTL_MS
      }
    ])
  })

  // S10-16 C1 review round 2 D2: a headless `orca serve` that never touches an orchestration verb
  // never constructs the DB (flushLegacySweepAudit is lazy), so queued audit rows would otherwise
  // sit silent until process exit and vanish. Load-time loud degradation: warn with the count.
  it('D2: warns once, naming the row count, when the sweep queues audit rows at load', () => {
    writeRegistryFile([
      {
        deviceId: 'legacy-runtime',
        name: 'Legacy runtime link',
        token: 'legacy-runtime-token',
        scope: 'runtime',
        pairedAt: Date.now(),
        lastSeenAt: 0
      },
      {
        deviceId: 'legacy-runtime-2',
        name: 'Legacy runtime link 2',
        token: 'legacy-runtime-token-2',
        scope: 'runtime',
        pairedAt: Date.now(),
        lastSeenAt: 0
      }
    ])

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const registry = new DeviceRegistry(userDataPath)
      // The flush mechanism is unchanged — this is an additional loud signal, not a replacement.
      expect(registry.getPendingLegacySweepAudit()).toHaveLength(2)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('2')
      expect(warnSpy.mock.calls[0]?.[0]).toContain('orchestration DB attaches')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('D2: does not warn when the sweep queues nothing', () => {
    writeRegistryFile([
      {
        deviceId: 'mobile-1',
        name: 'Phone',
        token: 'mobile-token',
        scope: 'mobile',
        pairedAt: Date.now(),
        lastSeenAt: Date.now()
      }
    ])

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const registry = new DeviceRegistry(userDataPath)
      expect(registry.getPendingLegacySweepAudit()).toEqual([])
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('F4: keeps an ALREADY-EXPIRED legacy row at load (never deleted by the sweep) but refuses it at validateToken, and it stays listable', () => {
    writeRegistryFile([
      {
        deviceId: 'stale-legacy-runtime',
        name: 'Stale legacy runtime link',
        token: 'stale-legacy-runtime-token',
        scope: 'runtime',
        // Far enough in the past that pairedAt + PENDING_GRANT_TTL_MS is already behind "now".
        pairedAt: 1_000,
        lastSeenAt: 0
      }
    ])

    const registry = new DeviceRegistry(userDataPath)

    const device = registry.getDevice('stale-legacy-runtime')
    expect(device).not.toBeNull()
    expect(device?.grantClass).toBe('legacy_coalesced')
    expect(registry.listDevices().some((d) => d.deviceId === 'stale-legacy-runtime')).toBe(true)
    expect(registry.validateToken('stale-legacy-runtime-token')).toBeNull()
    expect(registry.getPendingLegacySweepAudit()).toEqual([
      {
        deviceId: 'stale-legacy-runtime',
        name: 'Stale legacy runtime link',
        pairedAt: 1_000,
        legacyExpiresAt: 1_000 + PENDING_GRANT_TTL_MS
      }
    ])
  })

  it('F1: a swept row that is then CONSUMED (updateLastSeen) stays legacy_coalesced, never reads as minted', () => {
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

    registry.updateLastSeen('legacy-runtime')
    const consumed = registry.getDevice('legacy-runtime')

    expect(consumed?.lastSeenAt).not.toBe(0)
    expect(consumed?.grantClass).toBe('legacy_coalesced')
    expect(consumed?.pendingExpiresAt).toBeUndefined()
    // A consumed row is a real pairing — never expired/refused, regardless of its class.
    expect(registry.validateToken('legacy-runtime-token')?.deviceId).toBe('legacy-runtime')
  })

  it('leaves a mobile row of the same shape untouched', () => {
    writeRegistryFile([
      {
        deviceId: 'legacy-mobile',
        name: 'Legacy phone',
        token: 'legacy-mobile-token',
        scope: 'mobile',
        pairedAt: 1_000,
        lastSeenAt: 0
      }
    ])

    const registry = new DeviceRegistry(userDataPath)

    expect(registry.getDevice('legacy-mobile')?.grantClass).toBeUndefined()
    expect(registry.getDevice('legacy-mobile')?.pendingExpiresAt).toBeUndefined()
    expect(registry.getPendingLegacySweepAudit()).toEqual([])
  })

  it('leaves a relayBinding-holding row untouched', () => {
    writeRegistryFile([
      {
        deviceId: 'legacy-relay',
        name: 'Legacy relay row',
        token: 'legacy-relay-token',
        scope: 'runtime',
        pairedAt: 1_000,
        lastSeenAt: 0,
        relayBinding: {
          relayHostId: 'host-1',
          relayDeviceId: 'legacy-relay',
          ownerIdentityKey: 'owner-key'
        }
      }
    ])

    const registry = new DeviceRegistry(userDataPath)

    expect(registry.getDevice('legacy-relay')?.grantClass).toBeUndefined()
    expect(registry.getDevice('legacy-relay')?.pendingExpiresAt).toBeUndefined()
    expect(registry.getPendingLegacySweepAudit()).toEqual([])
  })

  it('leaves an already-connected row (lastSeenAt !== 0) untouched', () => {
    writeRegistryFile([
      {
        deviceId: 'scanned-runtime',
        name: 'Scanned runtime link',
        token: 'scanned-runtime-token',
        scope: 'runtime',
        pairedAt: 1_000,
        lastSeenAt: 5_000
      }
    ])

    const registry = new DeviceRegistry(userDataPath)

    expect(registry.getDevice('scanned-runtime')?.grantClass).toBeUndefined()
    expect(registry.getDevice('scanned-runtime')?.pendingExpiresAt).toBeUndefined()
    expect(registry.getPendingLegacySweepAudit()).toEqual([])
  })

  it('stamps nothing new on a second construction from the same on-disk file', () => {
    const pairedAt = Date.now()
    writeRegistryFile([
      {
        deviceId: 'legacy-runtime',
        name: 'Legacy runtime link',
        token: 'legacy-runtime-token',
        scope: 'runtime',
        pairedAt,
        lastSeenAt: 0
      }
    ])

    new DeviceRegistry(userDataPath).getPendingLegacySweepAudit()
    // No save() happened, so the file on disk is still the un-stamped legacy shape — the sweep
    // re-derives the SAME classification every load, it does not skip an already-stamped row.
    const second = new DeviceRegistry(userDataPath)
    expect(second.getPendingLegacySweepAudit()).toHaveLength(1)
    expect(second.getDevice('legacy-runtime')?.grantClass).toBe('legacy_coalesced')
    expect(second.getDevice('legacy-runtime')?.pendingExpiresAt).toBeUndefined()
  })

  it('★ the recomputed deadline is byte-identical across constructions with no intervening save() (v6, protocol M7)', () => {
    const pairedAt = Date.now()
    writeRegistryFile([
      {
        deviceId: 'legacy-runtime',
        name: 'Legacy runtime link',
        token: 'legacy-runtime-token',
        scope: 'runtime',
        pairedAt,
        lastSeenAt: 0
      }
    ])

    const first = new DeviceRegistry(userDataPath)
    const firstAudit = first.getPendingLegacySweepAudit()

    // No save() in between: the file on disk is still the un-stamped legacy shape. Nothing is
    // persisted onto pendingExpiresAt (F1) — the deadline is recomputed from the immutable
    // `pairedAt` every load, so it is byte-identical by construction regardless of restart cadence.
    const second = new DeviceRegistry(userDataPath)
    const secondAudit = second.getPendingLegacySweepAudit()

    expect(firstAudit[0]?.legacyExpiresAt).toBe(pairedAt + PENDING_GRANT_TTL_MS)
    expect(secondAudit[0]?.legacyExpiresAt).toBe(firstAudit[0]?.legacyExpiresAt)
  })

  it('sweep safety: stamps nothing when the registry load failed (loadSucceeded === false)', () => {
    // A directory at the registry path makes readFileSync throw ENOTDIR/EISDIR, i.e. a failed load.
    writeFileSync(registryFilePath(), '{not json', 'utf-8')

    const registry = new DeviceRegistry(userDataPath)

    expect(registry.loadSucceeded).toBe(false)
    expect(registry.listDevices()).toEqual([])
    expect(registry.getPendingLegacySweepAudit()).toEqual([])
  })

  it('sweep safety: stamps nothing on an empty device list', () => {
    writeRegistryFile([])

    const registry = new DeviceRegistry(userDataPath)

    expect(registry.loadSucceeded).toBe(true)
    expect(registry.listDevices()).toEqual([])
    expect(registry.getPendingLegacySweepAudit()).toEqual([])
  })
})
