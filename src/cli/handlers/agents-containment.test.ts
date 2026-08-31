import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { AGENT_CONTAINMENT_HANDLERS } from './agents-containment'

describe('agents purge/review CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('purge --message purges one message', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        outcome: 'purged',
        message: { id: 'msg_1', thread_id: 'thr_1' },
        alreadyPurged: false
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_CONTAINMENT_HANDLERS['agents purge']({
      flags: new Map<string, string | boolean>([
        ['message', 'msg_1'],
        ['reason', 'accidental secret paste']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.messages.purge', {
      messageId: 'msg_1',
      threadId: undefined,
      reason: 'accidental secret paste',
      acknowledgeGate: undefined
    })
    expect(String(log.mock.calls[0]?.[0])).toContain('Purged message msg_1')
  })

  it('purge --thread purges every message on the thread', async () => {
    const call = vi.fn().mockResolvedValue({ result: { outcome: 'purged', purgedCount: 4 } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_CONTAINMENT_HANDLERS['agents purge']({
      flags: new Map<string, string | boolean>([
        ['thread', 'thr_1'],
        ['reason', 'compromised channel']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(String(log.mock.calls[0]?.[0])).toContain('Purged 4 message(s)')
  })

  it('purge requires exactly one of --message or --thread', async () => {
    const call = vi.fn()
    await expect(
      AGENT_CONTAINMENT_HANDLERS['agents purge']({
        flags: new Map<string, string | boolean>([['reason', 'x']]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('purge --acknowledge-gate passes acknowledgeGate through (T11: the reason is gated too)', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { outcome: 'purged', message: { id: 'msg_1', thread_id: null }, alreadyPurged: false }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_CONTAINMENT_HANDLERS['agents purge']({
      flags: new Map<string, string | boolean>([
        ['message', 'msg_1'],
        ['reason', 'SECURITY: leaked key, purge on sight'],
        ['acknowledge-gate', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith(
      'orchestration.messages.purge',
      expect.objectContaining({ acknowledgeGate: true })
    )
  })

  it('review resolves a name to an agent id and prints withheld messages', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_bad', displayName: 'evil-agent', quarantined: true } }
        })
      }
      return Promise.resolve({
        result: {
          agent: { id: 'agt_bad', displayName: 'evil-agent' },
          messages: [{ id: 'msg_1', type: 'status', to_handle: 'agent:agt_x', subject: 'hi' }]
        }
      })
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_CONTAINMENT_HANDLERS['agents review']({
      flags: new Map<string, string | boolean>([['agent', 'evil-agent']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.agents.get', { name: 'evil-agent' })
    expect(call).toHaveBeenCalledWith('orchestration.agents.review', {
      agentId: 'agt_bad',
      limit: undefined
    })
    expect(String(log.mock.calls[0]?.[0])).toContain('evil-agent (agt_bad)')
  })

  it('review reports no authored messages plainly', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_x', displayName: 'clean-agent', quarantined: false } }
        })
      }
      return Promise.resolve({
        result: { agent: { id: 'agt_x', displayName: 'clean-agent' }, messages: [] }
      })
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_CONTAINMENT_HANDLERS['agents review']({
      flags: new Map<string, string | boolean>([['agent', 'clean-agent']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(String(log.mock.calls[0]?.[0])).toContain('has no authored messages')
  })
})
