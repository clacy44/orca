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

  // F-2 (Ruling 32(b)): before the fix, `'relay' in r` alone routed this shape into the worker-
  // Dispatch branch too, rendering "Queued undefined for worker Dispatch undefined" — the
  // peer_link relay (enqueueForeignReply, orchestration-reply-foreign.ts) has neither field.
  it('renders the actual peer-link relay receipt for a foreign-origin reply, never the dispatch fields', async () => {
    await expect(
      renderReply({
        message: { id: 'msg_reply_1' },
        relay: {
          destination: 'peer_link',
          environment: 'p-environment',
          accepted: true,
          state: 'queued',
          outboxId: 'obx_1',
          link: 'link_device_1'
        }
      })
    ).resolves.toBe('Queued msg_reply_1 for relay to p-environment (reply outbox obx_1).')
  })

  it('keeps the local receipt byte-identical', async () => {
    // Negative control: a local reply still renders exactly as before.
    await expect(renderReply({ message: { id: 'msg_reply' } })).resolves.toBe('Replied msg_reply')
  })

  it('stays readable for a CLI that predates the relay branch', () => {
    // Negative control: the shipped formatter dereferences message.id unconditionally, so a
    // relay receipt without that field is a TypeError on a reply the relay already accepted.
    const shippedFormatter = (r: { message: { id: string } }): string => `Replied ${r.message.id}`

    expect(
      shippedFormatter({
        relay: {
          messageId: 'relay_1',
          sequence: 3,
          dispatchId: 'ctx_remote',
          destination: 'worker',
          accepted: true
        },
        message: { id: 'relay_1' }
      } as never)
    ).toBe('Replied relay_1')
  })
})
