import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { RuntimeClientError } from './types'
import * as websocketTransport from './websocket-transport'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  removeEnvironment,
  resolveEnvironmentPairingOffer,
  setEnvironmentEndpoint
} from './environments'

function pairingCode(endpoint = 'ws://127.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

describe('CLI runtime environments', () => {
  const posixModeIt = process.platform === 'win32' ? it.skip : it

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('saves, resolves, and removes a paired environment', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-env-store-'))
    const saved = addEnvironmentFromPairingCode(userDataPath, {
      name: 'workstation',
      pairingCode: pairingCode(),
      now: 100
    })

    expect(listEnvironments(userDataPath)).toHaveLength(1)
    expect(resolveEnvironmentPairingOffer(userDataPath, 'workstation')).toMatchObject({
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'device-token'
    })
    expect(resolveEnvironmentPairingOffer(userDataPath, saved.id)).toMatchObject({
      endpoint: 'ws://127.0.0.1:6768'
    })
    expect(statSync(getEnvironmentStorePath(userDataPath)).isFile()).toBe(true)

    const removed = removeEnvironment(userDataPath, 'workstation')
    expect(removed.id).toBe(saved.id)
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  posixModeIt('stores paired environments with owner-only POSIX permissions', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-env-store-'))

    addEnvironmentFromPairingCode(userDataPath, {
      name: 'workstation',
      pairingCode: pairingCode(),
      now: 100
    })

    // Why: NTFS mode bits do not prove Windows ACL hardening; shared secure-file
    // tests cover that path, while POSIX hosts must keep the token store at 0600.
    expect((statSync(getEnvironmentStorePath(userDataPath)).mode & 0o777).toString(8)).toBe('600')
  })

  it('rejects an environment with the same name', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-env-store-'))
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'workstation',
      pairingCode: pairingCode('ws://127.0.0.1:1111'),
      now: 100
    })

    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'workstation',
        pairingCode: pairingCode('ws://127.0.0.1:2222'),
        now: 200
      })
    ).toThrow('A server named "workstation" already exists.')
    expect(listEnvironments(userDataPath)).toHaveLength(1)
    expect(resolveEnvironmentPairingOffer(userDataPath, 'workstation').endpoint).toBe(
      'ws://127.0.0.1:1111'
    )
    expect(listEnvironments(userDataPath)[0]?.id).toBe(first.id)
  })

  // S10-4 ruling 6: orca environment set-endpoint probes reachability before saving.
  describe('setEnvironmentEndpoint', () => {
    it('probes the new address and saves it once the probe succeeds', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-env-store-'))
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'workstation',
        pairingCode: pairingCode('ws://127.0.0.1:6768'),
        now: 100
      })
      const probe = vi.spyOn(websocketTransport, 'sendWebSocketRequest').mockResolvedValue({
        id: 'status',
        ok: true,
        result: {},
        _meta: { runtimeId: 'remote_runtime' }
      } as never)

      const result = await setEnvironmentEndpoint(userDataPath, 'workstation', {
        url: 'wss://tunnel.example:8443'
      })

      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'wss://tunnel.example:8443',
          deviceToken: 'device-token'
        }),
        'status.get',
        undefined,
        expect.any(Number)
      )
      expect(result.environment.endpoints[0]?.endpoint).toBe('wss://tunnel.example:8443')
      expect(resolveEnvironmentPairingOffer(userDataPath, 'workstation').endpoint).toBe(
        'wss://tunnel.example:8443'
      )
    })

    it('refuses and saves nothing when the new address is unreachable', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-env-store-'))
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'workstation',
        pairingCode: pairingCode('ws://127.0.0.1:6768'),
        now: 100
      })
      vi.spyOn(websocketTransport, 'sendWebSocketRequest').mockRejectedValue(
        new RuntimeClientError('runtime_unavailable', 'connect ECONNREFUSED')
      )

      await expect(
        setEnvironmentEndpoint(userDataPath, 'workstation', { url: 'wss://tunnel.example:8443' })
      ).rejects.toThrow(/Cannot reach Orca at wss:\/\/tunnel.example:8443/)
      expect(resolveEnvironmentPairingOffer(userDataPath, 'workstation').endpoint).toBe(
        'ws://127.0.0.1:6768'
      )
    })

    it('refuses a non-ws/wss scheme without ever probing the network', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-env-store-'))
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'workstation',
        pairingCode: pairingCode('ws://127.0.0.1:6768'),
        now: 100
      })
      const probe = vi.spyOn(websocketTransport, 'sendWebSocketRequest')

      await expect(
        setEnvironmentEndpoint(userDataPath, 'workstation', { url: 'http://tunnel.example:8443' })
      ).rejects.toThrow(/must be a ws:\/\/ or wss:\/\/ URL/)
      expect(probe).not.toHaveBeenCalled()
      expect(resolveEnvironmentPairingOffer(userDataPath, 'workstation').endpoint).toBe(
        'ws://127.0.0.1:6768'
      )
    })
  })
})
