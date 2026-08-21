import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE

// Why: isolate the send handler's rendering; printResult only writes the formatted line to stdout.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

type SendFormatterResult = Parameters<typeof printResult>[0]

async function renderSend(result: unknown): Promise<string | undefined> {
  callMock.mockReset().mockResolvedValue({ result })
  vi.mocked(printResult).mockReset()
  await ORCHESTRATION_HANDLERS['orchestration send']({
    flags: new Map<string, string | boolean>([
      ['from', 'term_worker'],
      ['subject', 'alive'],
      ['type', 'heartbeat']
    ]),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: false
  } as never)
  const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
    | ((value: SendFormatterResult) => string)
    | undefined
  return formatter?.(result as SendFormatterResult)
}

describe('orchestration send pendingMail hint', () => {
  beforeEach(() => {
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
  })

  afterEach(() => {
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
  })

  it('appends the hint to the local Sent branch', async () => {
    await expect(renderSend({ message: { id: 'msg_1' }, pendingMail: 2 })).resolves.toBe(
      'Sent msg_1\nUnread coordinator mail: 2 — run orchestration check'
    )
  })

  it('appends the hint to a federated worker relay to its Run home', async () => {
    await expect(
      renderSend({
        relay: {
          messageId: 'msg_relay',
          sequence: 4,
          dispatchId: 'ctx_remote',
          destination: 'run_home',
          accepted: true
        },
        pendingMail: 1
      })
    ).resolves.toBe(
      'Queued msg_relay for Run home (Dispatch ctx_remote)\nUnread coordinator mail: 1 — run orchestration check'
    )
  })

  it('appends the hint to the worker-destination relay branch', async () => {
    await expect(
      renderSend({
        relay: {
          messageId: 'msg_worker',
          sequence: 7,
          dispatchId: 'ctx_worker',
          destination: 'worker',
          accepted: true
        },
        pendingMail: 5
      })
    ).resolves.toBe(
      'Queued msg_worker for worker Dispatch ctx_worker\nUnread coordinator mail: 5 — run orchestration check'
    )
  })

  it('renders every branch byte-identically when the runtime sends no field', async () => {
    // Negative control: an old runtime omits pendingMail, so output must not move at all.
    await expect(renderSend({ message: { id: 'msg_1' } })).resolves.toBe('Sent msg_1')
    await expect(
      renderSend({
        relay: {
          messageId: 'msg_relay',
          sequence: 4,
          dispatchId: 'ctx_remote',
          destination: 'run_home',
          accepted: true
        }
      })
    ).resolves.toBe('Queued msg_relay for Run home (Dispatch ctx_remote)')
    await expect(
      renderSend({
        relay: {
          messageId: 'msg_worker',
          sequence: 7,
          dispatchId: 'ctx_worker',
          destination: 'worker',
          accepted: true
        }
      })
    ).resolves.toBe('Queued msg_worker for worker Dispatch ctx_worker')
    await expect(renderSend({ messages: [{ id: 'msg_a' }], recipients: 1 })).resolves.toBe(
      'Sent 1 messages to 1 recipients'
    )
  })

  it('never renders a zero count', async () => {
    // Negative control: 0 is not a signal — a runtime that sends it must still print today's line.
    await expect(renderSend({ message: { id: 'msg_1' }, pendingMail: 0 })).resolves.toBe(
      'Sent msg_1'
    )
  })

  it('leaves the group fan-out branch alone', async () => {
    await expect(
      renderSend({ messages: [{ id: 'msg_a' }, { id: 'msg_b' }], recipients: 2, pendingMail: 9 })
    ).resolves.toBe('Sent 2 messages to 2 recipients')
  })
})
