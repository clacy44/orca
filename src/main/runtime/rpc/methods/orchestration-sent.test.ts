import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'

function request(id: string, method: string, params: Record<string, unknown>): RpcRequest {
  return {
    id: `rpc_${id}`,
    authToken: 'worker-token',
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: `request_${id}`,
    method,
    params
  }
}

describe('orchestration.sent (BUG 3)', () => {
  let db: OrchestrationDb | undefined
  let runtime: OrcaRuntimeService | undefined
  let dispatcher: RpcDispatcher

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
  }

  afterEach(() => {
    db?.close()
    db = undefined
    runtime = undefined
  })

  it('reports queued for a message sent to a peer with no live terminal', async () => {
    setup()
    const message = db!.insertMessage({ from: 'term_a', to: 'term_ghost', subject: 'hi' })

    const response = await dispatcher.dispatch(
      request('sent-1', 'orchestration.sent', { id: message.id })
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        delivery: {
          state: 'queued',
          recipient: { state: 'unresolved', lastSeenAt: null }
        }
      }
    })
  })

  it('reports read once the recipient marks it read', async () => {
    setup()
    const message = db!.insertMessage({ from: 'term_a', to: 'term_b', subject: 'hi' })
    db!.markAsRead([message.id])

    const response = await dispatcher.dispatch(
      request('sent-2', 'orchestration.sent', { id: message.id })
    )

    expect(response).toMatchObject({ ok: true, result: { delivery: { state: 'read' } } })
  })

  it('rejects an unknown message id', async () => {
    setup()

    const response = await dispatcher.dispatch(
      request('sent-3', 'orchestration.sent', { id: 'msg_missing' })
    )

    expect(response).toMatchObject({ ok: false })
  })

  // RPC-level integration (S10-0 review minor): drives the real ambient-push machinery
  // (deliverPendingMessagesForHandle against a live, idle leaf) rather than asserting on
  // runtime-private state directly, and reads the result back through the actual
  // `orchestration.sent` RPC handler — the same path a real CLI/RPC caller uses.
  it('reports pointed once deliverPendingMessagesForHandle writes into a live idle leaf', async () => {
    setup()
    const write = vi.fn().mockReturnValue(true)
    runtime!.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => null
    } as never)
    runtime!.attachWindow(1)
    runtime!.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Codex',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: null
        }
      ]
    })
    const [terminal] = (await runtime!.listTerminals()).terminals
    // Why two frames: `lastAgentStatusObservedLive` only flips true once a live PTY frame is
    // actually observed — an idle-from-birth leaf reads as a cold restore, not a push-eligible one.
    runtime!.onPtyData('pty-1', ']0;Codex working', 100)
    runtime!.onPtyData('pty-1', ']0;Codex done', 101)

    const message = db!.insertMessage({ from: 'term_a', to: terminal.handle, subject: 'ping' })
    const preResponse = await dispatcher.dispatch(
      request('sent-pre', 'orchestration.sent', { id: message.id })
    )
    expect(preResponse).toMatchObject({ ok: true, result: { delivery: { state: 'queued' } } })

    runtime!.deliverPendingMessagesForHandle(terminal.handle)
    expect(write).toHaveBeenCalled()

    const response = await dispatcher.dispatch(
      request('sent-pointed', 'orchestration.sent', { id: message.id })
    )

    expect(response).toMatchObject({ ok: true, result: { delivery: { state: 'pointed' } } })
    // Still unread — pointed is "written into the pane", not "read by the recipient".
    expect(db!.getMessageById(message.id)?.read).toBe(0)
  })
})
