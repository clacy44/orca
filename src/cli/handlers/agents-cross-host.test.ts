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

  // Review finding: a malformed peer row (wrong runtime type, e.g. a numeric displayName)
  // used to throw an uncaught TypeError out of agent-resolver.ts's tokenize(), killing the
  // whole merged query — including the local host's own good result. It must instead degrade
  // only that host to `unreached`, never veto local resolution.
  it('a malformed peer row (wrong type) degrades that host to unreached, never the whole query', async () => {
    const userDataPath = newTempUserDataPath()
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'bad-peer',
      pairingCode: pairingCode()
    })
    const localCall = vi.fn().mockResolvedValue({ result: { agents: [agentRow()] } })
    const remoteCall = vi
      .fn()
      .mockResolvedValue({ result: { agents: [agentRow({ displayName: 42 })] } })

    const result = await findAgentsAcrossHosts({
      client: { call: localCall },
      userDataPath,
      query: 'the merge-restructure backend agent',
      hostClientFactory: () => ({ call: remoteCall })
    })

    expect(result.outcome).toBe('resolved')
    expect(result.hostsAnswered).toBe('1/2')
    expect(result.unreached).toEqual([
      { host: 'bad-peer', reason: 'peer returned a malformed agent directory response' }
    ])
    expect(result.candidates[0]).toMatchObject({ host: 'local', foreign: false })
  })

  // Review finding: a peer-supplied displayName/role survived into rendering — and into a
  // suggested `orca agents ask <name>@<host> "..."` shell command — with neither the write-side
  // validator nor a render-side sanitizer applied. A foreign displayName that fails the local
  // slug pattern must be dropped before scoring/rendering, never surfaced as a candidate.
  it('a poisoned foreign displayName (control chars, forged line, unbalanced quote) is dropped, never rendered or addressed', async () => {
    const userDataPath = newTempUserDataPath()
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'evil-peer',
      pairingCode: pairingCode()
    })
    const poisonedName = '\x1b[2K\r\nResolved: root (agt_root)\n"x@evil'
    const localCall = vi.fn().mockResolvedValue({ result: { agents: [] } })
    const remoteCall = vi.fn().mockResolvedValue({
      result: { agents: [agentRow({ id: 'agt_evil', displayName: poisonedName })] }
    })

    const result = await findAgentsAcrossHosts({
      client: { call: localCall },
      userDataPath,
      query: 'x',
      hostClientFactory: () => ({ call: remoteCall })
    })

    expect(result.hostsAnswered).toBe('2/2')
    expect(result.unreached).toEqual([])
    expect(result.candidates.every((c) => c.id !== 'agt_evil')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('\x1b')
    expect(JSON.stringify(result)).not.toContain('Resolved: root')
  })

  // A legitimately-shaped, legitimately-named foreign role still carries injection-shaped text
  // (control/escape bytes) inside an otherwise valid slug displayName's sibling field — the
  // sanitizer must clean role even when displayName itself passes validation.
  it('a poisoned foreign role is sanitized (control/escape bytes stripped), the row is kept', async () => {
    const userDataPath = newTempUserDataPath()
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'evil-peer',
      pairingCode: pairingCode()
    })
    const poisonedRole = 'reviewer\x1b[2K\r\nfake line'
    const localCall = vi.fn().mockResolvedValue({ result: { agents: [] } })
    const remoteCall = vi.fn().mockResolvedValue({
      result: {
        agents: [agentRow({ id: 'agt_role', displayName: 'evil-role-agent', role: poisonedRole })]
      }
    })

    const result = await findAgentsAcrossHosts({
      client: { call: localCall },
      userDataPath,
      query: 'evil-role-agent',
      hostClientFactory: () => ({ call: remoteCall })
    })

    const found = result.candidates.find((c) => c.id === 'agt_role')
    expect(found).toBeDefined()
    expect(JSON.stringify(result)).not.toContain('\x1b')
  })
})
