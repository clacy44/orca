import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.hoisted(() => vi.fn())
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalExitCode = process.exitCode

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

type CheckFormatterResult = Parameters<typeof printResult>[0]

async function runCheck(result: Record<string, unknown>): Promise<string | undefined> {
  callMock.mockReset().mockResolvedValue({ result })
  vi.mocked(printResult).mockReset()
  await ORCHESTRATION_HANDLERS['orchestration check']({
    flags: new Map<string, string | boolean>([
      ['wait', true],
      ['ack', 'delivery_1']
    ]),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: false
  } as never)
  const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
    | ((value: CheckFormatterResult) => string)
    | undefined
  return formatter?.(result as CheckFormatterResult)
}

describe('orchestration check waitInterrupted', () => {
  beforeEach(() => {
    getTerminalHandleMock.mockReset()
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    process.exitCode = undefined
  })

  afterEach(() => {
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
    process.exitCode = originalExitCode
  })

  it('fails loudly and names the rebind when the consumer was replaced', async () => {
    const rendered = await runCheck({
      messages: [],
      count: 0,
      runId: 'run_7',
      acknowledged: 'delivery_1',
      timedOut: false,
      cancelled: false,
      waitInterrupted: 'consumer_fenced'
    })

    expect(rendered).toBe(
      'Wait ended: this mailbox consumer was replaced. Rebind with: orca orchestration run-use --id run_7'
    )
    expect(process.exitCode).toBe(1)
  })

  it('reports a competing waiter without failing the process', async () => {
    const rendered = await runCheck({
      messages: [],
      count: 0,
      runId: 'run_7',
      acknowledged: 'delivery_1',
      timedOut: false,
      cancelled: false,
      waitInterrupted: 'waiter_exists'
    })

    expect(rendered).toContain('another actionable waiter')
    expect(process.exitCode).toBeUndefined()
  })

  it('names an applied acknowledgement whose wait outcome is unknown without failing', async () => {
    const rendered = await runCheck({
      messages: [],
      count: 0,
      runId: 'run_7',
      acknowledged: 'delivery_1',
      timedOut: false,
      cancelled: false,
      waitInterrupted: 'outcome_unknown'
    })

    expect(rendered).toContain("acknowledged its Delivery but the wait's outcome is unknown")
    expect(rendered).not.toBe('No messages.')
    expect(process.exitCode).toBeUndefined()
  })

  it('leaves an ordinary empty mailbox exactly as it was', async () => {
    const rendered = await runCheck({
      messages: [],
      count: 0,
      runId: 'run_7',
      timedOut: false,
      cancelled: false
    })

    expect(rendered).toBe('No messages.')
    expect(process.exitCode).toBeUndefined()
  })

  it('leaves a plain timeout exactly as it was', async () => {
    const rendered = await runCheck({
      messages: [],
      count: 0,
      runId: 'run_7',
      timedOut: true,
      cancelled: false
    })

    expect(rendered).toBe('Wait timed out; no messages were consumed.')
    expect(process.exitCode).toBeUndefined()
  })
})
