// Series 3, dual behaviour (owner decision 3): `orca orchestration check` opts the
// dispatch:/bare-handle mailboxes into replay-until-ack durability by default (ackMode:
// 'implicit'), wire-compatible with an older runtime because the param is additive and simply
// ignored there — never a status.get negotiation round trip (see the Why comment in the
// handler). `--legacy-destructive-read` force-opts back to the old immediate mark-read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

describe('orchestration check ackMode', () => {
  beforeEach(() => {
    callMock.mockReset()
    callMock.mockResolvedValue({ result: { messages: [], count: 0 } })
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
  })

  afterEach(() => {
    delete process.env.ORCA_TERMINAL_HANDLE
    vi.restoreAllMocks()
  })

  const invokeCheck = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration check']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('sends ackMode:"implicit" by default, with a single RPC call (no capability round trip)', async () => {
    await invokeCheck(new Map())

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ ackMode: 'implicit' })
    )
  })

  it('--legacy-destructive-read omits ackMode and warns once on stderr', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await invokeCheck(new Map([['legacy-destructive-read', true]]))

    expect(callMock).toHaveBeenCalledTimes(1)
    const [, params] = callMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(params.ackMode).toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--legacy-destructive-read'))
  })
})
