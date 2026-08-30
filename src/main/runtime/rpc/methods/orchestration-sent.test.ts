import { afterEach, describe, expect, it } from 'vitest'
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
})
