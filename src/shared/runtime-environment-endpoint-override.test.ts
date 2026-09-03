import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  markEnvironmentUsed,
  RuntimeEnvironmentStoreError
} from './runtime-environment-store'
import {
  assertValidEnvironmentEndpointUrl,
  markEnvironmentPairingStale,
  setEnvironmentEndpoint
} from './runtime-environment-endpoint-override'

function pairingCode(endpoint = 'ws://127.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

describe('runtime environment endpoint override (S10-4 rulings 6/7)', () => {
  const tempDirs: string[] = []
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // S10-4 ruling 6: a tunnel deployment needs an address override; scheme is refused up front.
  it('assertValidEnvironmentEndpointUrl refuses a scheme other than ws/wss', () => {
    expect(() => assertValidEnvironmentEndpointUrl('http://tunnel.example:8443')).toThrow(
      /must be a ws:\/\/ or wss:\/\/ URL/
    )
    expect(() => assertValidEnvironmentEndpointUrl('wss://tunnel.example:8443')).not.toThrow()
    expect(() => assertValidEnvironmentEndpointUrl('ws://127.0.0.1:9999')).not.toThrow()
  })

  it('setEnvironmentEndpoint overrides the preferred endpoint address only, credentials untouched', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const saved = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode('ws://127.0.0.1:6768')
    })

    const updated = setEnvironmentEndpoint(userDataPath, 'dev box', {
      url: 'wss://tunnel.example:8443',
      now: saved.updatedAt + 1000
    })

    expect(updated.endpoints).toHaveLength(1)
    expect(updated.endpoints[0]).toMatchObject({
      endpoint: 'wss://tunnel.example:8443',
      deviceToken: saved.endpoints[0]!.deviceToken,
      publicKeyB64: saved.endpoints[0]!.publicKeyB64
    })
    expect(updated.updatedAt).toBe(saved.updatedAt + 1000)
    expect(listEnvironments(userDataPath)).toEqual([updated])
  })

  // S10-16 R4.4 / C1 review finding 5+6 (scenario 10): re-pointing the endpoint must bump
  // pairingRevision exactly as updateEnvironmentFromPairingCode does — a stale binding must
  // re-prove rather than read as still-live against the new address.
  it('setEnvironmentEndpoint bumps pairingRevision (R4.4)', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const saved = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode('ws://127.0.0.1:6768')
    })
    const savedRevision = saved.pairingRevision ?? saved.createdAt

    const updated = setEnvironmentEndpoint(userDataPath, 'dev box', {
      url: 'wss://tunnel.example:8443',
      now: saved.updatedAt + 1000
    })

    expect(updated.pairingRevision).toBeDefined()
    expect(updated.pairingRevision!).toBeGreaterThan(savedRevision)
    expect(updated.pairingRevision!).toBe(Math.max(saved.updatedAt + 1000, savedRevision + 1))
  })

  it('setEnvironmentEndpoint refuses a bad scheme without touching the saved environment', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const saved = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode('ws://127.0.0.1:6768')
    })

    expect(() =>
      setEnvironmentEndpoint(userDataPath, 'dev box', { url: 'http://tunnel.example:8443' })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(listEnvironments(userDataPath)).toEqual([saved])
  })

  // S10-4 ruling 7: the relay loop's own marker, self-healed on the next successful round trip.
  it('markEnvironmentPairingStale sets the flag; markEnvironmentUsed clears it on success', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode('ws://127.0.0.1:6768'),
      now: 100
    })

    markEnvironmentPairingStale(userDataPath, 'dev box')
    expect(listEnvironments(userDataPath)[0]?.pairingState).toBe('stale_pairing')

    // A successful round trip clears it even when lastUsedAt is otherwise still "fresh" —
    // self-healing must not wait out the lastUsedAt throttle window.
    markEnvironmentUsed(userDataPath, 'dev box', { now: 150 })
    expect(listEnvironments(userDataPath)[0]?.pairingState).toBe('ok')
  })

  it('markEnvironmentPairingStale is idempotent', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode('ws://127.0.0.1:6768'),
      now: 100
    })

    markEnvironmentPairingStale(userDataPath, 'dev box')
    expect(() => markEnvironmentPairingStale(userDataPath, 'dev box')).not.toThrow()
    expect(listEnvironments(userDataPath)[0]?.pairingState).toBe('stale_pairing')
  })
})
