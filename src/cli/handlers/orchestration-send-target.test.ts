import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { encodePairingOffer } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../runtime/environments'
import { resolveSendTarget } from './orchestration-send-target'

let testUserDataPath = ''

function pairingCode(): string {
  return encodePairingOffer({
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

describe('resolveSendTarget (S10-15 F1 R1/R2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const localCall = vi.fn()
  const localClient = { call: localCall } as unknown as RuntimeClient

  it('@all passes through untouched', async () => {
    const result = await resolveSendTarget(localClient, '/tmp/unused', '@all')
    expect(result).toEqual({ to: '@all' })
  })

  it('run:x passes through untouched', async () => {
    const result = await resolveSendTarget(localClient, '/tmp/unused', 'run:x')
    expect(result).toEqual({ to: 'run:x' })
  })

  it('dispatch:x passes through untouched', async () => {
    const result = await resolveSendTarget(localClient, '/tmp/unused', 'dispatch:x')
    expect(result).toEqual({ to: 'dispatch:x' })
  })

  it('unqualified agent:agt_… passes through untouched', async () => {
    const result = await resolveSendTarget(localClient, '/tmp/unused', 'agent:agt_aaaaaaaaaaaa')
    expect(result).toEqual({ to: 'agent:agt_aaaaaaaaaaaa' })
  })

  it('a legacy bare handle (no @) passes through untouched', async () => {
    const result = await resolveSendTarget(localClient, '/tmp/unused', 'worker-one')
    expect(result).toEqual({ to: 'worker-one' })
  })

  it('name@host resolves on the peer client and yields {to, host}', async () => {
    testUserDataPath = mkdtempSync(join(tmpdir(), 'orca-send-target-'))
    const saved = addEnvironmentFromPairingCode(testUserDataPath, {
      name: 'vps',
      pairingCode: pairingCode()
    })
    const remoteCall = vi.fn().mockResolvedValue({
      result: { agent: { id: 'agt_them', displayName: 'peer-agent', quarantined: false } }
    })
    const hostClientFactory = vi
      .fn()
      .mockReturnValue({ call: remoteCall } as unknown as RuntimeClient)

    const result = await resolveSendTarget(
      localClient,
      testUserDataPath,
      'peer-agent@vps',
      hostClientFactory
    )
    expect(result).toEqual({ to: 'agent:agt_them', host: saved.name })
    expect(remoteCall).toHaveBeenCalledWith('orchestration.agents.get', {
      name: 'peer-agent',
      id: undefined
    })
  })

  it('agent:agt_x@host also resolves', async () => {
    testUserDataPath = mkdtempSync(join(tmpdir(), 'orca-send-target-'))
    addEnvironmentFromPairingCode(testUserDataPath, { name: 'vps', pairingCode: pairingCode() })
    const remoteCall = vi.fn().mockResolvedValue({
      result: { agent: { id: 'agt_them', displayName: 'peer-agent', quarantined: false } }
    })
    const hostClientFactory = vi
      .fn()
      .mockReturnValue({ call: remoteCall } as unknown as RuntimeClient)

    const result = await resolveSendTarget(
      localClient,
      testUserDataPath,
      'agent:agt_aaaaaaaaaaaa@vps',
      hostClientFactory
    )
    expect(result.to).toBe('agent:agt_them')
    expect(result.host).toBe('vps')
    expect(remoteCall).toHaveBeenCalledWith('orchestration.agents.get', {
      name: undefined,
      id: 'agt_aaaaaaaaaaaa'
    })
  })

  it('a quarantined remote agent throws agent_quarantined', async () => {
    testUserDataPath = mkdtempSync(join(tmpdir(), 'orca-send-target-'))
    addEnvironmentFromPairingCode(testUserDataPath, { name: 'vps', pairingCode: pairingCode() })
    const remoteCall = vi.fn().mockResolvedValue({
      result: { agent: { id: 'agt_them', displayName: 'peer-agent', quarantined: true } }
    })
    const hostClientFactory = vi
      .fn()
      .mockReturnValue({ call: remoteCall } as unknown as RuntimeClient)

    await expect(
      resolveSendTarget(localClient, testUserDataPath, 'peer-agent@vps', hostClientFactory)
    ).rejects.toMatchObject({ code: 'agent_quarantined' })
  })

  it('an unknown environment throws with "Unknown environment"', async () => {
    testUserDataPath = mkdtempSync(join(tmpdir(), 'orca-send-target-'))
    await expect(
      resolveSendTarget(localClient, testUserDataPath, 'peer-agent@nowhere')
    ).rejects.toThrow(/Unknown environment/)
  })
})
