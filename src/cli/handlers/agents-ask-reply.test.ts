import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { AGENT_ASK_REPLY_HANDLERS } from './agents-ask-reply'

describe('agents ask/reply CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('ask: resolves the name to agent:<id> and asks with no --thread/--to needed ("one command to start")', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
        })
      }
      return Promise.resolve({
        result: {
          answer: 'rebase onto 12ddb0a first',
          messageId: 'msg_a1',
          threadId: 'thr_9fk2',
          timedOut: false,
          timeoutMs: 47_000
        }
      })
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_ASK_REPLY_HANDLERS['agents ask']({
      flags: new Map<string, string | boolean>([
        ['name', 'backend-merge'],
        ['question', 'did db.ts land yet?']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.agents.get', { name: 'backend-merge' })
    expect(call).toHaveBeenCalledWith(
      'orchestration.ask',
      expect.objectContaining({ to: 'agent:agt_them', question: 'did db.ts land yet?' }),
      expect.anything()
    )
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('rebase onto 12ddb0a first')
    expect(printed).toContain('Continue: orca agents reply --thread thr_9fk2 --body "..."')
  })

  it('ask: refuses a quarantined target before ever calling orchestration.ask', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_bad', displayName: 'evil-agent', quarantined: true } }
        })
      }
      throw new Error('must not reach orchestration.ask')
    })
    await expect(
      AGENT_ASK_REPLY_HANDLERS['agents ask']({
        flags: new Map<string, string | boolean>([
          ['name', 'evil-agent'],
          ['question', 'hi']
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toMatchObject({ code: 'agent_quarantined' })
  })

  it('ask: a timeout exits 0 and points at agents wait instead of re-asking', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
        })
      }
      return Promise.resolve({
        result: {
          answer: null,
          messageId: 'msg_a1',
          threadId: 'thr_9fk2',
          timedOut: true,
          timeoutMs: 600_000
        }
      })
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    process.exitCode = undefined
    await AGENT_ASK_REPLY_HANDLERS['agents ask']({
      flags: new Map<string, string | boolean>([
        ['name', 'backend-merge'],
        ['question', 'hi']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(process.exitCode).toBeUndefined()
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain(
      'Resume without re-asking: orca agents wait --thread thr_9fk2 --for reply'
    )
  })

  it('ask --json emits the bare RPC result, not an envelope', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
        })
      }
      return Promise.resolve({
        result: { answer: 'ok', messageId: 'msg_a1', threadId: 'thr_1', timedOut: false }
      })
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_ASK_REPLY_HANDLERS['agents ask']({
      flags: new Map<string, string | boolean>([
        ['name', 'backend-merge'],
        ['question', 'hi']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: true
    } as never)
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ answer: 'ok' })
  })

  it('ask --acknowledge-gate passes acknowledgeGate through to the RPC', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
        })
      }
      return Promise.resolve({
        result: { answer: 'ok', messageId: 'msg_a1', threadId: 'thr_1', timedOut: false }
      })
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_ASK_REPLY_HANDLERS['agents ask']({
      flags: new Map<string, string | boolean>([
        ['name', 'backend-merge'],
        ['question', 'merge gate FAIL: CVE-2025-1234, fix is a version bump'],
        ['acknowledge-gate', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith(
      'orchestration.ask',
      expect.objectContaining({ acknowledgeGate: true }),
      expect.anything()
    )
  })

  it('reply --id replies directly to a message id', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { message: { id: 'msg_b2', thread_id: 'thr_9fk2' }, duplicate: false }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_ASK_REPLY_HANDLERS['agents reply']({
      flags: new Map<string, string | boolean>([
        ['id', 'msg_a1'],
        ['body', 'rebase onto 12ddb0a first']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.reply', {
      id: 'msg_a1',
      body: 'rebase onto 12ddb0a first',
      acknowledgeGate: undefined
    })
    expect(String(log.mock.calls[0]?.[0])).toContain('Replied msg_b2')
  })

  it('reply --thread resolves to the latest message on the thread', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.threads.get') {
        return Promise.resolve({
          result: { messages: [{ id: 'msg_old' }, { id: 'msg_a1' }] }
        })
      }
      return Promise.resolve({
        result: { message: { id: 'msg_b2', thread_id: 'thr_9fk2' }, duplicate: false }
      })
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_ASK_REPLY_HANDLERS['agents reply']({
      flags: new Map<string, string | boolean>([
        ['thread', 'thr_9fk2'],
        ['body', 'reply text']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.reply', {
      id: 'msg_a1',
      body: 'reply text',
      acknowledgeGate: undefined
    })
  })

  it('reply --thread on an empty thread fails clearly instead of calling reply with an undefined id', async () => {
    const call = vi.fn().mockResolvedValue({ result: { messages: [] } })
    await expect(
      AGENT_ASK_REPLY_HANDLERS['agents reply']({
        flags: new Map<string, string | boolean>([
          ['thread', 'thr_empty'],
          ['body', 'reply text']
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('reply requires exactly one of --thread or --id', async () => {
    const call = vi.fn()
    await expect(
      AGENT_ASK_REPLY_HANDLERS['agents reply']({
        flags: new Map<string, string | boolean>([
          ['thread', 'thr_1'],
          ['id', 'msg_1'],
          ['body', 'x']
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('reply surfaces a duplicate answer distinctly', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { message: { id: 'msg_b2', thread_id: 'thr_9fk2' }, duplicate: true }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_ASK_REPLY_HANDLERS['agents reply']({
      flags: new Map<string, string | boolean>([
        ['id', 'msg_a1'],
        ['body', 'same answer again']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(String(log.mock.calls[0]?.[0])).toContain('duplicate of a previous answer')
  })
})
