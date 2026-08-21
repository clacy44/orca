import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import {
  encodeFederatedControlMessage,
  importFederatedControlMessage
} from '../../orchestration/federation-control-message'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'

type SendResult = { pendingMail?: number; lifecycle?: { action: string } }

const WORKER_PANE_KEY = 'tab_worker:leaf_worker'
const WORKER_HANDLE = 'term_worker'

describe('orchestration.send pendingMail', () => {
  let db: OrchestrationDb | undefined
  let runtime: OrcaRuntimeService | undefined

  afterEach(() => {
    runtime?.stopOrchestrationFederationRelay()
    db?.close()
    db = undefined
    runtime = undefined
    vi.restoreAllMocks()
  })

  function localSetup(): {
    dispatcher: RpcDispatcher
    dispatchId: string
    taskId: string
    orchestrationDb: OrchestrationDb
  } {
    const orchestrationDb = new OrchestrationDb(':memory:')
    db = orchestrationDb
    const service = new OrcaRuntimeService()
    runtime = service
    service.setOrchestrationDb(orchestrationDb)
    vi.spyOn(service, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === WORKER_HANDLE ? WORKER_PANE_KEY : null
    )
    vi.spyOn(service, 'getTerminalProcessIncarnation').mockReturnValue('worker_epoch:pty:1')
    // Why: the send handler pushes the outbound notice through the PTY path; the mailbox count is what's under test.
    vi.spyOn(service, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
    const run = orchestrationDb.createRun({
      objective: 'pending mail',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = orchestrationDb.createTask({ spec: 'work', runId: run.id })
    const dispatch = orchestrationDb.createDispatchContext(task.id, WORKER_HANDLE, WORKER_PANE_KEY)
    return {
      dispatcher: new RpcDispatcher({ runtime: service, methods: ORCHESTRATION_METHODS }),
      dispatchId: dispatch.id,
      taskId: task.id,
      orchestrationDb
    }
  }

  function queueCoordinatorMail(
    orchestrationDb: OrchestrationDb,
    dispatchId: string,
    count: number
  ): void {
    for (let index = 0; index < count; index += 1) {
      importFederatedControlMessage(orchestrationDb, {
        dispatchId,
        messageId: `msg_pending_${dispatchId}_${index}`,
        payload: encodeFederatedControlMessage({
          from: 'term_coord',
          subject: `follow-up ${index}`,
          body: 'scope changed',
          type: 'status',
          priority: 'normal',
          threadId: null,
          payload: null
        })
      })
    }
  }

  async function send(
    dispatcher: RpcDispatcher,
    id: string,
    params: Record<string, unknown>,
    capability?: string
  ): Promise<SendResult> {
    const response = await dispatcher.dispatch(
      request(id, 'orchestration.send', params, capability)
    )
    expect(response).toMatchObject({ ok: true })
    return (response as { result: SendResult }).result
  }

  it('reports the unread dispatch mailbox count on a local heartbeat', async () => {
    const { dispatcher, dispatchId, taskId, orchestrationDb } = localSetup()
    queueCoordinatorMail(orchestrationDb, dispatchId, 2)

    const result = await send(dispatcher, 'hb', {
      from: WORKER_HANDLE,
      subject: 'alive',
      type: 'heartbeat',
      payload: JSON.stringify({ taskId, dispatchId })
    })

    expect(result.pendingMail).toBe(2)
  })

  it('omits the field rather than reporting zero on an empty mailbox', async () => {
    const { dispatcher, dispatchId, taskId } = localSetup()

    const result = await send(dispatcher, 'hb_empty', {
      from: WORKER_HANDLE,
      subject: 'alive',
      type: 'heartbeat',
      payload: JSON.stringify({ taskId, dispatchId })
    })

    expect(result).not.toHaveProperty('pendingMail')
  })

  it('stops counting mail the worker already read', async () => {
    const { dispatcher, dispatchId, taskId, orchestrationDb } = localSetup()
    queueCoordinatorMail(orchestrationDb, dispatchId, 1)
    orchestrationDb.markAsRead(
      orchestrationDb.getUnreadMessages(`dispatch:${dispatchId}`).map((message) => message.id)
    )

    const result = await send(dispatcher, 'hb_read', {
      from: WORKER_HANDLE,
      subject: 'alive',
      type: 'heartbeat',
      payload: JSON.stringify({ taskId, dispatchId })
    })

    expect(result).not.toHaveProperty('pendingMail')
  })

  it('carries no field on a non-heartbeat send from the same worker', async () => {
    const { dispatcher, dispatchId, taskId, orchestrationDb } = localSetup()
    queueCoordinatorMail(orchestrationDb, dispatchId, 3)

    for (const type of ['escalation', 'status'] as const) {
      const result = await send(dispatcher, type, {
        from: WORKER_HANDLE,
        subject: `worker ${type}`,
        type,
        payload: JSON.stringify({ taskId, dispatchId })
      })
      expect(result).not.toHaveProperty('pendingMail')
    }
  })

  it('carries no field on worker_done even with mail waiting', async () => {
    const { dispatcher, dispatchId, taskId, orchestrationDb } = localSetup()
    queueCoordinatorMail(orchestrationDb, dispatchId, 4)

    const result = await send(dispatcher, 'done', {
      from: WORKER_HANDLE,
      subject: 'finished',
      type: 'worker_done',
      payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
    })

    expect(result).not.toHaveProperty('pendingMail')
  })

  it('carries no field when the sender has no active dispatch', async () => {
    const { dispatcher, dispatchId, taskId, orchestrationDb } = localSetup()
    queueCoordinatorMail(orchestrationDb, dispatchId, 2)
    orchestrationDb.completeDispatch(dispatchId)

    const result = await send(dispatcher, 'hb_settled', {
      from: WORKER_HANDLE,
      subject: 'alive',
      type: 'heartbeat',
      payload: JSON.stringify({ taskId, dispatchId })
    })

    expect(result).not.toHaveProperty('pendingMail')
  })

  it('answers a suppressed heartbeat with the verdict and still reports waiting mail', async () => {
    const { dispatcher, dispatchId, taskId, orchestrationDb } = localSetup()
    orchestrationDb.completeDispatch(dispatchId)
    // A retry re-dispatches the same pane, so mail is waiting. The straggler heartbeat from the
    // settled attempt carries the closed-relationship verdict, and keeps the hint a CLI that
    // predates the verdict still prints — dropping it would regress that old client (Rule 3).
    const retryTask = orchestrationDb.createTask({
      spec: 'retry',
      runId: orchestrationDb.getTask(taskId)?.run_id
    })
    orchestrationDb.updateTaskStatus(retryTask.id, 'ready')
    const retry = orchestrationDb.createDispatchContext(
      retryTask.id,
      WORKER_HANDLE,
      WORKER_PANE_KEY
    )
    queueCoordinatorMail(orchestrationDb, retry.id, 2)

    const result = await send(dispatcher, 'hb_straggler', {
      from: WORKER_HANDLE,
      subject: 'alive',
      type: 'heartbeat',
      payload: JSON.stringify({ taskId, dispatchId })
    })

    expect(result).toMatchObject({
      lifecycle: { action: 'suppressed', dispatchId, reason: 'Dispatch is no longer active.' },
      pendingMail: 2
    })
  })

  it('stays silent for a worker whose pane is bound to a Run its check would read instead', async () => {
    const { dispatcher, dispatchId, taskId, orchestrationDb } = localSetup()
    queueCoordinatorMail(orchestrationDb, dispatchId, 3)
    // Negative control: `check` takes the Run branch for this pane and never reaches the
    // dispatch mailbox, so hinting at unread mail would send the worker to "No messages."
    orchestrationDb.createRun({
      objective: 'nested run',
      coordinatorHandle: WORKER_HANDLE,
      coordinatorPaneKey: WORKER_PANE_KEY
    })

    const result = await send(dispatcher, 'hb_nested', {
      from: WORKER_HANDLE,
      subject: 'alive',
      type: 'heartbeat',
      payload: JSON.stringify({ taskId, dispatchId })
    })

    expect(result).not.toHaveProperty('pendingMail')
  })

  it('reports the count on a federated worker heartbeat relayed to its Run home', async () => {
    const orchestrationDb = new OrchestrationDb(':memory:')
    db = orchestrationDb
    const service = new OrcaRuntimeService()
    runtime = service
    service.setOrchestrationDb(orchestrationDb)
    const processIncarnation = 'worker_epoch:pty:1'
    vi.spyOn(service, 'getTerminalPaneKey').mockReturnValue(WORKER_PANE_KEY)
    vi.spyOn(service, 'getTerminalProcessIncarnation').mockReturnValue(processIncarnation)
    const dispatchId = 'ctx_remote_pending_mail'
    orchestrationDb.createRemoteDispatchAttachment({
      dispatchId,
      taskId: 'task_remote_pending_mail',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: service.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'attach_request',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach_payload'
      }
    })
    const capability = orchestrationDb.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: WORKER_PANE_KEY,
      processIncarnation,
      worktreeId: 'repo::remote-worktree',
      terminalHandle: WORKER_HANDLE,
      setupState: 'not_applicable',
      effects: []
    })
    orchestrationDb.markRemoteAttachmentReady(dispatchId)
    queueCoordinatorMail(orchestrationDb, dispatchId, 3)
    const dispatcher = new RpcDispatcher({ runtime: service, methods: ORCHESTRATION_METHODS })

    const heartbeat = await send(
      dispatcher,
      'remote_hb',
      { from: WORKER_HANDLE, subject: 'alive', type: 'heartbeat' },
      capability
    )
    expect(heartbeat).toMatchObject({ relay: { destination: 'run_home' }, pendingMail: 3 })

    // Negative control: the same worker's non-heartbeat relay carries nothing.
    const status = await send(
      dispatcher,
      'remote_status',
      { from: WORKER_HANDLE, subject: 'progress', type: 'status' },
      capability
    )
    expect(status).not.toHaveProperty('pendingMail')
  })
})

function request(
  id: string,
  method: 'orchestration.send',
  params: Record<string, unknown>,
  capability?: string
): RpcRequest {
  return {
    id: `rpc_${id}`,
    authToken: 'worker-token',
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: `request_${id}`,
    ...(capability ? { orchestrationCapability: capability } : {}),
    method,
    params
  }
}
