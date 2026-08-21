import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalCliCommand = process.env.ORCA_CLI_COMMAND

// Why: isolate the send handler's verdict handling; printResult only writes the formatted line.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { requireWorkerDoneSettlement } from './orchestration-worker-settlement'

function sendHeartbeat(result: unknown): Promise<void> {
  return send(result, 'heartbeat')
}

function sendStatus(result: unknown): Promise<void> {
  return send(result, 'status')
}

function send(result: unknown, type: string): Promise<void> {
  callMock.mockReset().mockResolvedValue({ result })
  return ORCHESTRATION_HANDLERS['orchestration send']({
    flags: new Map<string, string | boolean>([
      ['from', 'term_worker'],
      ['subject', 'alive'],
      ['type', type]
    ]),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: false
  } as never)
}

describe('orchestration send heartbeat verdict', () => {
  beforeEach(() => {
    // Why pin the binary: the recovery step names the resolved CLI, which is platform-derived.
    process.env.ORCA_CLI_COMMAND = 'orca'
  })

  afterEach(() => {
    vi.mocked(printResult).mockReset()
    getTerminalHandleMock.mockReset()
    if (originalCliCommand === undefined) {
      delete process.env.ORCA_CLI_COMMAND
    } else {
      process.env.ORCA_CLI_COMMAND = originalCliCommand
    }
  })

  it('raises the suppressed verdict for the CLI error boundary', async () => {
    await expect(
      sendHeartbeat({
        message: { id: 'msg_suppressed' },
        lifecycle: {
          action: 'suppressed',
          dispatchId: 'ctx_1',
          reason: 'Dispatch is no longer active.'
        }
      })
    ).rejects.toMatchObject({
      code: 'dispatch_inactive',
      message:
        'Heartbeat suppressed: Dispatch ctx_1 is no longer active — stop work and do not send worker_done for this Dispatch.',
      // Why the steps: formatCliError renders `data.nextSteps` as `Next step:` lines, so this
      // refusal is a signpost rather than the dead end §16 exists to remove.
      data: {
        effectsApplied: false,
        nextSteps: [
          'Stop work on this Dispatch; do not send worker_done for it.',
          'Read what the coordinator sent instead: orca orchestration check --terminal term_worker'
        ]
      }
    })
    expect(printResult).not.toHaveBeenCalled()
  })

  it('names the sent type when a future path suppresses something else', async () => {
    // Negative control: the verdict is a lifecycle field any send can carry, so the noun must
    // not claim a heartbeat for a message that was not one.
    await expect(
      sendStatus({
        message: { id: 'msg_suppressed' },
        lifecycle: { action: 'suppressed', dispatchId: 'ctx_1' }
      })
    ).rejects.toMatchObject({
      code: 'dispatch_inactive',
      message:
        'Message suppressed: Dispatch ctx_1 is no longer active — stop work and do not send worker_done for this Dispatch.'
    })
  })

  it('prints the receipt unchanged for a delivered heartbeat', async () => {
    // Negative control: a live Dispatch carries no verdict and must still print Sent <id>.
    await sendHeartbeat({ message: { id: 'msg_alive' } })

    expect(printResult).toHaveBeenCalledOnce()
    const formatter = vi.mocked(printResult).mock.calls[0][2] as (value: unknown) => string
    expect(formatter({ message: { id: 'msg_alive' } })).toBe('Sent msg_alive')
  })

  it('prints the receipt unchanged against a runtime that sends no verdict', async () => {
    // Negative control: an older runtime answers a suppressed heartbeat with a bare message.
    await sendHeartbeat({ message: { id: 'msg_old_host' }, pendingMail: 2 })

    expect(printResult).toHaveBeenCalledOnce()
  })

  it('never reads the verdict as a worker_done settlement', async () => {
    // Negative control: the settlement guard is scoped to worker_done, so an unrecognized
    // action cannot turn a heartbeat into a spurious operation_unknown.
    callMock.mockReset()
    await expect(
      requireWorkerDoneSettlement(
        { call: callMock } as never,
        'heartbeat',
        JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1', outcome: 'succeeded' }),
        { message: { id: 'msg_suppressed' }, lifecycle: { action: 'suppressed' } }
      )
    ).resolves.toBeUndefined()
    expect(callMock).not.toHaveBeenCalled()
  })
})
