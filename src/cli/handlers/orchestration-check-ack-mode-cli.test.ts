// Series 3, dual behaviour (owner decision 3): `orca orchestration check` opts the
// dispatch:/bare-handle mailboxes into replay-until-ack durability by default (ackMode:
// 'implicit'). The param is sent unconditionally, not negotiated: it is an additive optional RPC
// param, so an old host's zod schema silently drops it and behaves exactly as before (zero
// regression) — a capability round trip would cost every check call, including tight `--wait`
// long-poll loops, for no benefit. (Adversarial review, blocker: an earlier `status.get`
// negotiation broke the pinned invariant that a plain check never probes before reading the
// caller-handle mailbox; deleted.) `--legacy-destructive-read` force-opts back to the old
// immediate mark-read.
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

  const invokeCheck = (flags: Map<string, string | boolean>, client: unknown) =>
    ORCHESTRATION_HANDLERS['orchestration check']({
      flags,
      client,
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('sends ackMode:"implicit" by default on a local connection, with a single RPC call (no capability round trip)', async () => {
    await invokeCheck(new Map(), { call: callMock, isRemote: false })

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ ackMode: 'implicit' })
    )
  })

  it('--legacy-destructive-read omits ackMode and warns once on stderr', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await invokeCheck(new Map([['legacy-destructive-read', true]]), {
      call: callMock,
      isRemote: false
    })

    expect(callMock).toHaveBeenCalledTimes(1)
    const [, params] = callMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(params.ackMode).toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--legacy-destructive-read'))
  })

  // MUTATION PROOF: sends ackMode:'implicit' unconditionally on a remote connection too — no
  // status.get probe, and no dependence on what the remote advertises. Reintroducing a
  // capability check here would reintroduce the extra round trip the blocker fix removed.
  it('a remote connection also sends ackMode:"implicit" with a single RPC call (no status.get probe)', async () => {
    await invokeCheck(new Map(), { call: callMock, isRemote: true })

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ ackMode: 'implicit' })
    )
  })

  it('a remote connection with --legacy-destructive-read also omits ackMode, still one RPC call', async () => {
    await invokeCheck(new Map([['legacy-destructive-read', true]]), {
      call: callMock,
      isRemote: true
    })

    expect(callMock).toHaveBeenCalledTimes(1)
    const [, params] = callMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(params.ackMode).toBeUndefined()
  })
})
