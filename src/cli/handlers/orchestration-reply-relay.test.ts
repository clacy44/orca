import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE

// Why: isolate the reply handler's rendering; printResult only writes the formatted line.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

type ReplyFormatterResult = Parameters<typeof printResult>[0]

async function renderReply(result: unknown): Promise<string | undefined> {
  callMock.mockReset().mockResolvedValue({ result })
  vi.mocked(printResult).mockReset()
  await ORCHESTRATION_HANDLERS['orchestration reply']({
    flags: new Map<string, string | boolean>([
      ['from', 'term_coord'],
      ['id', 'msg_escalation'],
      ['body', 'Proceed on main.']
    ]),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: false
  } as never)
  const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
    | ((value: ReplyFormatterResult) => string)
    | undefined
  return formatter?.(result as ReplyFormatterResult)
}

describe('orchestration reply receipt rendering', () => {
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

  it('names the relayed Dispatch when the reply crosses to a federated worker', async () => {
    await expect(
      renderReply({
        relay: {
          messageId: 'relay_1',
          sequence: 3,
          dispatchId: 'ctx_remote',
          destination: 'worker',
          accepted: true
        }
      })
    ).resolves.toBe('Queued relay_1 for worker Dispatch ctx_remote')
  })

  it('keeps the local receipt byte-identical', async () => {
    // Negative control: a local reply still renders exactly as before.
    await expect(renderReply({ message: { id: 'msg_reply' } })).resolves.toBe('Replied msg_reply')
  })
})
