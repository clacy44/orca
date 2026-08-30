import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { ORCHESTRATION_HANDLERS } from './orchestration'

describe('orchestration thread CLI (BUG 4)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls orchestration.thread with --id and --since, and prints a populated next command', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        count: 1,
        messages: [
          {
            id: 'msg_1',
            from_handle: 'term_a',
            to_handle: 'term_b',
            subject: 'hi',
            type: 'status',
            created_at: '2026-08-30T12:00:00Z',
            sequence: 7
          }
        ]
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await ORCHESTRATION_HANDLERS['orchestration thread']({
      flags: new Map([
        ['id', 'thread_1'],
        ['since', '3']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/repo',
      json: false
    } as never)

    expect(call).toHaveBeenCalledWith('orchestration.thread', {
      id: 'thread_1',
      since: '3'
    })
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('msg_1')
    expect(printed).toContain('Next step:')
    expect(printed).toContain('--since 7')
  })

  it('passes --thread-id through on orchestration inbox', async () => {
    const call = vi.fn().mockResolvedValue({ result: { messages: [], count: 0 } })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await ORCHESTRATION_HANDLERS['orchestration inbox']({
      flags: new Map([['thread-id', 'thread_1']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/repo',
      json: false
    } as never)

    expect(call).toHaveBeenCalledWith(
      'orchestration.inbox',
      expect.objectContaining({ threadId: 'thread_1' })
    )
  })
})
