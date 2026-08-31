import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { AGENT_THREAD_HANDLERS } from './agents-threads'

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thr_9fk2',
    subject: 'merge restructure: db.ts conflict',
    created_by_agent_id: 'agt_me',
    origin: 'peer',
    state: 'open',
    sensitive: 0,
    created_at: '2026-01-01 00:00:00',
    last_message_at: '2026-01-01 00:05:00',
    last_message_id: 'msg_181',
    last_message_sequence: 181,
    message_count: 3,
    pact_with_agent_id: null,
    pact_state: null,
    pact_turn_agent_id: null,
    pact_at: null,
    purged_at: null,
    purge_reason: null,
    purged_by_agent_id: null,
    ...overrides
  }
}

function threadMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_181',
    from_handle: 'agent:agt_them',
    to_handle: 'agent:agt_me',
    subject: 'schema freeze',
    body: 'rebase onto 12ddb0a first',
    type: 'status',
    priority: 'normal',
    thread_id: 'thr_9fk2',
    sequence: 181,
    created_at: '2026-01-01 14:02:00',
    ...overrides
  }
}

describe('agents threads CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('threads: lists with a footer next step', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        threads: [
          {
            id: 'thr_9fk2',
            subject: 'merge restructure: db.ts conflict',
            state: 'open',
            sensitive: false,
            lastMessageAt: new Date().toISOString(),
            messageCount: 3,
            pact: null
          }
        ],
        nextSteps: []
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_THREAD_HANDLERS['agents threads']({
      flags: new Map(),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.threads.list', {
      state: undefined,
      limit: undefined
    })
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('thr_9fk2')
    expect(printed).toContain('Read one: orca agents thread --id <id>')
  })

  it('threads: reports no threads with a next step to start one', async () => {
    const call = vi.fn().mockResolvedValue({ result: { threads: [], nextSteps: [] } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_THREAD_HANDLERS['agents threads']({
      flags: new Map(),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(String(log.mock.calls[0]?.[0])).toContain('No threads.')
  })

  it('thread --new resolves names to agent ids before creating', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
        })
      }
      return Promise.resolve({
        result: {
          thread: thread(),
          participants: [{}, {}],
          nextSteps: []
        }
      })
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_THREAD_HANDLERS['agents thread']({
      flags: new Map<string, string | boolean>([
        ['new', true],
        ['with', 'backend-merge'],
        ['subject', 'db.ts conflict']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.agents.get', { name: 'backend-merge' })
    expect(call).toHaveBeenCalledWith('orchestration.threads.create', {
      subject: 'db.ts conflict',
      with: 'agent:agt_them',
      sensitive: undefined
    })
    expect(String(log.mock.calls[0]?.[0])).toContain('Started thread thr_9fk2')
  })

  it('thread --id reads a thread and prints a resumable Continue hint (T9 shape)', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        thread: thread(),
        participants: [],
        messages: [threadMessage()],
        count: 1,
        degraded: false
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_THREAD_HANDLERS['agents thread']({
      flags: new Map<string, string | boolean>([['id', 'thr_9fk2']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.threads.get', {
      id: 'thr_9fk2',
      since: undefined
    })
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('#181 14:02 agent:agt_them: rebase onto 12ddb0a first')
    expect(printed).toContain('Continue: orca agents thread --id thr_9fk2 --since 181')
  })

  it('thread --id --leave leaves the thread', async () => {
    const call = vi.fn().mockResolvedValue({ result: { left: true } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_THREAD_HANDLERS['agents thread']({
      flags: new Map<string, string | boolean>([
        ['id', 'thr_9fk2'],
        ['leave', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.threads.leave', { id: 'thr_9fk2' })
    expect(String(log.mock.calls[0]?.[0])).toContain('Left thread thr_9fk2.')
  })

  it('thread without --id or --new fails with a clear invalid_argument', async () => {
    const call = vi.fn()
    await expect(
      AGENT_THREAD_HANDLERS['agents thread']({
        flags: new Map(),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('wait: prints messages and a resume hint on a fresh reply', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        outcome: 'reply',
        messages: [threadMessage({ from_handle: 'agent:agt_them' })],
        resumeToken: 'wait_thr_9fk2_181',
        waitedMs: 1200,
        nextSteps: []
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_THREAD_HANDLERS['agents wait']({
      flags: new Map<string, string | boolean>([
        ['thread', 'thr_9fk2'],
        ['for', 'reply']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('rebase onto 12ddb0a first')
    expect(printed).toContain(
      'Continue: orca agents wait --thread thr_9fk2 --for reply --resume wait_thr_9fk2_181'
    )
  })

  it('wait: a timeout is not treated as a failure exit', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        outcome: 'timeout',
        messages: [],
        resumeToken: 'wait_thr_9fk2_180',
        waitedMs: 60_000,
        nextSteps: []
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    process.exitCode = undefined
    await AGENT_THREAD_HANDLERS['agents wait']({
      flags: new Map<string, string | boolean>([
        ['thread', 'thr_9fk2'],
        ['for', 'reply']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(process.exitCode).toBeUndefined()
  })

  it('wait: rejects an invalid --for value client-side', async () => {
    const call = vi.fn()
    await expect(
      AGENT_THREAD_HANDLERS['agents wait']({
        flags: new Map<string, string | boolean>([
          ['thread', 'thr_9fk2'],
          ['for', 'nonsense']
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })
})
