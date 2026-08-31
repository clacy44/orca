import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../runtime/environments'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime/types'
import { nameOrId, parseAgentSelector, resolveAgentAcrossHost } from './agents-shared'

function pairingCode(): string {
  return encodePairingOffer({
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

function fakeClient(call: (...args: unknown[]) => unknown): RuntimeClient {
  return { call } as unknown as RuntimeClient
}

describe('parseAgentSelector', () => {
  it('has no @ at all: local host, same shape as nameOrId', () => {
    expect(parseAgentSelector('backend-merge')).toEqual({
      ...nameOrId('backend-merge'),
      host: 'local'
    })
    expect(parseAgentSelector('agt_abc123')).toEqual({ ...nameOrId('agt_abc123'), host: 'local' })
  })

  it('splits name@host on the last @', () => {
    expect(parseAgentSelector('backend-merge@work-laptop')).toEqual({
      name: 'backend-merge',
      host: 'work-laptop'
    })
  })

  it('a leading or trailing @ is not a host address', () => {
    expect(parseAgentSelector('@work-laptop').host).toBe('local')
    expect(parseAgentSelector('backend-merge@').host).toBe('local')
  })
})

describe('resolveAgentAcrossHost', () => {
  it('local (no @host): calls the caller-supplied client directly, never a host factory', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { agent: { id: 'agt_1', displayName: 'backend-merge', quarantined: false } }
    })
    const client = fakeClient(call)
    const factory = vi.fn()
    const resolved = await resolveAgentAcrossHost(client, '/tmp/unused', 'backend-merge', factory)
    expect(resolved.host).toBe('local')
    expect(resolved.client).toBe(client)
    expect(resolved.agent).toMatchObject({ id: 'agt_1' })
    expect(factory).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledWith('orchestration.agents.get', { name: 'backend-merge' })
  })

  it('name@host: resolves the saved environment and calls the host-specific client', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-agents-shared-'))
    const saved = addEnvironmentFromPairingCode(userDataPath, {
      name: 'work-laptop',
      pairingCode: pairingCode()
    })
    const call = vi.fn().mockResolvedValue({
      result: { agent: { id: 'agt_2', displayName: 'backend-merge', quarantined: false } }
    })
    const hostClient = fakeClient(call)
    const factory = vi.fn().mockReturnValue(hostClient)
    const localClient = fakeClient(vi.fn())

    const resolved = await resolveAgentAcrossHost(
      localClient,
      userDataPath,
      'backend-merge@work-laptop',
      factory
    )
    expect(factory).toHaveBeenCalledWith(saved.id)
    expect(resolved.host).toBe('work-laptop')
    expect(resolved.client).toBe(hostClient)
    expect(call).toHaveBeenCalledWith('orchestration.agents.get', { name: 'backend-merge' })
  })

  it('name@unknown-host: refuses before ever calling a client', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-agents-shared-'))
    const call = vi.fn()
    const client = fakeClient(call)
    await expect(
      resolveAgentAcrossHost(client, userDataPath, 'backend-merge@nowhere', vi.fn())
    ).rejects.toBeInstanceOf(RuntimeClientError)
    expect(call).not.toHaveBeenCalled()
  })
})
