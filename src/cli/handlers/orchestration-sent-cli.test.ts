import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { ORCHESTRATION_HANDLERS } from './orchestration'

describe('orchestration sent CLI (BUG 3)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls orchestration.sent with --id and prints the delivery state', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        delivery: { state: 'pointed', recipient: { state: 'connected', lastSeenAt: 42 } }
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await ORCHESTRATION_HANDLERS['orchestration sent']({
      flags: new Map([['id', 'msg_1']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/repo',
      json: false
    } as never)

    expect(call).toHaveBeenCalledWith('orchestration.sent', { id: 'msg_1' })
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('msg_1: pointed')
    expect(printed).toContain('recipient connected')
  })
})
