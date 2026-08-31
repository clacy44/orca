import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../runtime/environments'
import { addressOf, findAgentsAcrossHosts } from './agents-cross-host'

function pairingCode(): string {
  return encodePairingOffer({
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agt_local',
    displayName: 'backend-merge',
    role: 'backend for the merge restructure',
    title: null,
    worktreePath: '/repo',
    branch: 'merge-restructure',
    state: 'live',
    derived: false,
    ...overrides
  }
}

function newTempUserDataPath(): string {
  return mkdtempSync(join(tmpdir(), 'orca-agents-cross-host-'))
}

describe('findAgentsAcrossHosts', () => {
  it('no saved environments: resolves locally, hostsAnswered 1/1, no unreached', async () => {
    const userDataPath = newTempUserDataPath()
    const call = vi.fn().mockResolvedValue({ result: { agents: [agentRow()] } })
    const result = await findAgentsAcrossHosts({
      client: { call },
      userDataPath,
      query: 'the merge-restructure backend agent'
    })
    expect(result.outcome).toBe('resolved')
    expect(result.hostsAnswered).toBe('1/1')
    expect(result.unreached).toEqual([])
    expect(result.candidates[0]).toMatchObject({ host: 'local', foreign: false, id: 'agt_local' })
  })

  it('a same-named row on a second host makes an otherwise-resolved query ambiguous, addressed name@host', async () => {
    const userDataPath = newTempUserDataPath()
    const saved = addEnvironmentFromPairingCode(userDataPath, {
      name: 'work-laptop',
      pairingCode: pairingCode()
    })
    const localCall = vi.fn().mockResolvedValue({ result: { agents: [agentRow()] } })
    const remoteCall = vi
      .fn()
      .mockResolvedValue({ result: { agents: [agentRow({ id: 'agt_remote' })] } })
    const hostClientFactory = vi.fn().mockImplementation((environmentId: string) => {
      expect(environmentId).toBe(saved.id)
      return { call: remoteCall }
    })

    const result = await findAgentsAcrossHosts({
      client: { call: localCall },
      userDataPath,
      query: 'the merge-restructure backend agent',
      hostClientFactory
    })

    expect(result.outcome).toBe('ambiguous')
    expect(result.hostsAnswered).toBe('2/2')
    expect(result.candidates.map((c) => `${c.id}@${c.host}`).sort()).toEqual([
      'agt_local@local',
      'agt_remote@work-laptop'
    ])
    const remote = result.candidates.find((c) => c.host === 'work-laptop')!
    expect(remote.foreign).toBe(true)
    expect(addressOf(remote)).toBe('backend-merge@work-laptop')
    const local = result.candidates.find((c) => c.host === 'local')!
    expect(local.foreign).toBe(false)
    expect(addressOf(local)).toBe('backend-merge')
    expect(result.nextSteps).toContain('orca agents show backend-merge@work-laptop')
  })

  it('an unreachable peer lands in unreached and never blocks a local resolution (ruling 11)', async () => {
    const userDataPath = newTempUserDataPath()
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'work-laptop',
      pairingCode: pairingCode()
    })
    const localCall = vi.fn().mockResolvedValue({ result: { agents: [agentRow()] } })
    const remoteCall = vi.fn().mockRejectedValue(Object.assign(new Error('offline'), {}))

    const result = await findAgentsAcrossHosts({
      client: { call: localCall },
      userDataPath,
      query: 'the merge-restructure backend agent',
      hostClientFactory: () => ({ call: remoteCall })
    })

    expect(result.outcome).toBe('resolved')
    expect(result.hostsAnswered).toBe('1/2')
    expect(result.unreached).toEqual([{ host: 'work-laptop', reason: 'offline' }])
    expect(result.candidates[0]).toMatchObject({ host: 'local', foreign: false })
  })

  it('a capability-missing peer degrades gracefully with a readable unreached reason', async () => {
    const userDataPath = newTempUserDataPath()
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'old-peer',
      pairingCode: pairingCode()
    })
    const localCall = vi.fn().mockResolvedValue({ result: { agents: [] } })
    const remoteCall = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('unknown method'), { code: 'method_not_found' }))

    const result = await findAgentsAcrossHosts({
      client: { call: localCall },
      userDataPath,
      query: 'anything',
      hostClientFactory: () => ({ call: remoteCall })
    })

    expect(result.unreached).toEqual([
      { host: 'old-peer', reason: 'peer does not support the agent directory' }
    ])
  })

  it('no match anywhere reports no_match with hosts-answered', async () => {
    const userDataPath = newTempUserDataPath()
    const call = vi.fn().mockResolvedValue({ result: { agents: [] } })
    const result = await findAgentsAcrossHosts({
      client: { call },
      userDataPath,
      query: 'nothing like this exists'
    })
    expect(result.outcome).toBe('no_match')
    expect(result.hostsAnswered).toBe('1/1')
  })
})
