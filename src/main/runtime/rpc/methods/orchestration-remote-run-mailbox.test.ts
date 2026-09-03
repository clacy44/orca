import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_REMOTE_RUN_MAILBOX_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'

// Why: the peer is the runtime that OWNS the Run; the caller is a paired runtime with no
// pane here, which is exactly the case pane-bound Run scope can never satisfy.
describe('remote run mailbox on the Run-owning peer', () => {
  const peerCoordinatorPaneKey = 'tab_peer:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  let peerDb: OrchestrationDb
  let peerRuntime: OrcaRuntimeService
  let peerDispatcher: RpcDispatcher
  let runId: string

  beforeEach(() => {
    peerDb = new OrchestrationDb(':memory:')
    peerRuntime = new OrcaRuntimeService()
    peerRuntime.setOrchestrationDb(peerDb)
    vi.spyOn(peerRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_peer_coord' ? peerCoordinatorPaneKey : null
    )
    vi.spyOn(peerRuntime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    vi.spyOn(peerRuntime, 'notifyMessageArrived').mockImplementation(() => {})
    peerDispatcher = new RpcDispatcher({ runtime: peerRuntime, methods: ORCHESTRATION_METHODS })
    runId = peerDb.createRun({
      objective: 'Run that lives on the peer',
      coordinatorHandle: 'term_peer_coord',
      coordinatorPaneKey: peerCoordinatorPaneKey
    }).id
  })

  afterEach(() => {
    peerDb.close()
    vi.restoreAllMocks()
  })

  // Why: mirrors the WebSocket path, the only transport that carries a paired identity.
  async function callAsPairedRuntime(request: RpcRequest): Promise<RpcResponse> {
    let response: RpcResponse | undefined
    await peerDispatcher.dispatchStreaming(
      request,
      (raw) => {
        response = JSON.parse(raw) as RpcResponse
      },
      { pairedDeviceId: 'device_caller_runtime', clientKind: 'runtime', clientId: 'caller-token' }
    )
    return response as RpcResponse
  }

  function checkRequest(id: string, params: Record<string, unknown> = {}): RpcRequest {
    return {
      id,
      authToken: 'caller-token',
      method: 'orchestration.check',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      params: { terminal: 'term_caller_on_other_runtime', run: runId, ...params }
    }
  }

  function postRunMail(subject: string): string {
    return peerDb.insertMessage({
      from: 'term_peer_coord',
      to: `run:${runId}`,
      subject,
      body: 'Body from the peer coordinator.',
      runId
    }).id
  }

  it('advertises the capability so clients can negotiate before relying on the param', () => {
    expect(peerRuntime.getStatus().capabilities).toContain(
      ORCHESTRATION_REMOTE_RUN_MAILBOX_RUNTIME_CAPABILITY
    )
  })

  it('reads the Run mailbox for a paired caller that owns no pane here', async () => {
    postRunMail('Mail for the other runtime')

    const response = await callAsPairedRuntime(
      checkRequest('remote-read', { remoteRunMailbox: true })
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        runId,
        // H4d: every path through the run branch names the mailbox it read, same as the
        // agent/bare-handle branches (Ruling 32 Addendum 13).
        mailbox: `run:${runId}`,
        count: 1,
        messages: [{ subject: 'Mail for the other runtime', to_handle: `run:${runId}` }]
      }
    })
  })

  it('acknowledges the delivery in the peer database, not on the caller side', async () => {
    const messageId = postRunMail('Ack me')
    const read = (await callAsPairedRuntime(
      checkRequest('remote-read-ack', { remoteRunMailbox: true })
    )) as RpcResponse & { result: { deliveryId: string } }
    const deliveryId = read.result.deliveryId

    const acked = await callAsPairedRuntime(
      checkRequest('remote-ack', { remoteRunMailbox: true, ack: deliveryId })
    )

    expect(acked).toMatchObject({ ok: true, result: { acknowledged: deliveryId } })
    expect(peerDb.getMessageById(messageId)?.read).toBe(1)
    expect(peerDb.getRunMailboxHistory(runId).filter((m) => m.read === 0)).toHaveLength(0)
  })

  it('does not rebind the Run, so the peer-local coordinator keeps its consumer generation', async () => {
    postRunMail('Shared mailbox')
    const before = peerDb.getRun(runId)?.consumer_generation

    await callAsPairedRuntime(checkRequest('remote-no-rebind', { remoteRunMailbox: true }))

    expect(peerDb.getRun(runId)?.consumer_generation).toBe(before)
    expect(peerDb.getRun(runId)?.coordinator_pane_key).toBe(peerCoordinatorPaneKey)
  })

  it('lands a cross-runtime send in the peer Run mailbox exactly like a local send', async () => {
    const sent = await callAsPairedRuntime({
      id: 'remote-send',
      authToken: 'caller-token',
      method: 'orchestration.send',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      params: {
        from: 'term_caller_on_other_runtime',
        to: `run:${runId}`,
        subject: 'Cross-runtime instruction',
        body: 'Pick this up on your runtime.',
        remoteRunMailbox: true
      }
    })

    expect(sent).toMatchObject({ ok: true, result: { message: { run_id: runId } } })
    expect(peerDb.getRunMailboxHistory(runId)).toMatchObject([
      { to_handle: `run:${runId}`, subject: 'Cross-runtime instruction' }
    ])
  })

  it('refuses a cross-runtime send with no explicit recipient instead of guessing a local Run', async () => {
    const sent = await callAsPairedRuntime({
      id: 'remote-send-no-target',
      authToken: 'caller-token',
      method: 'orchestration.send',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      params: {
        from: 'term_peer_coord',
        subject: 'Ambiguous',
        remoteRunMailbox: true
      }
    })

    expect(sent).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(peerDb.getRunMailboxHistory(runId)).toHaveLength(0)
  })

  it('answers a Run-scoped question raised on the peer', async () => {
    const task = peerDb.createTask({ spec: 'ask the coordinator', runId })
    const dispatch = peerDb.createDispatchContext(task.id, 'term_peer_worker')
    const question = peerDb.createQuestion({
      runId,
      dispatchId: dispatch.id,
      askerHandle: 'term_peer_worker',
      question: 'Which branch?'
    })

    const replied = await callAsPairedRuntime({
      id: 'remote-reply',
      authToken: 'caller-token',
      method: 'orchestration.reply',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      params: {
        id: question.message.id,
        body: 'Use the release branch.',
        from: 'term_caller_on_other_runtime',
        remoteRunMailbox: true
      }
    })

    expect(replied).toMatchObject({ ok: true, result: { question: { status: 'answered' } } })
    expect(peerDb.getQuestion(question.message.id)?.status).toBe('answered')
  })

  it('rejects an unpaired caller that asks for the remote mailbox', async () => {
    postRunMail('Not for you')

    // Why: dispatch() is the local Unix-socket path — no paired device identity is attached.
    const response = await peerDispatcher.dispatch(
      checkRequest('unpaired-read', { remoteRunMailbox: true })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'remote_mailbox_unpaired' } })
  })

  it('rejects a paired mobile-scope caller, which never carries terminal-drive rights', async () => {
    postRunMail('Not for mobile')
    let response: RpcResponse | undefined
    await peerDispatcher.dispatchStreaming(
      checkRequest('mobile-read', { remoteRunMailbox: true }),
      (raw) => {
        response = JSON.parse(raw) as RpcResponse
      },
      { pairedDeviceId: 'device_phone', clientKind: 'mobile', clientId: 'phone-token' }
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'remote_mailbox_unpaired' } })
  })

  it('still fences a local caller whose pane is bound to a different Run', async () => {
    const otherRun = peerDb.createRun({
      objective: 'Other Run',
      coordinatorHandle: 'term_peer_coord',
      coordinatorPaneKey: peerCoordinatorPaneKey
    })

    const response = await peerDispatcher.dispatch({
      id: 'local-fenced',
      authToken: 'local-token',
      method: 'orchestration.check',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      params: { terminal: 'term_peer_coord', run: runId }
    })

    expect(otherRun.id).not.toBe(runId)
    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
  })

  it('still requires a bound pane for a local caller that omits the opt-in', async () => {
    postRunMail('Local unbound')

    const response = await peerDispatcher.dispatch(checkRequest('local-unbound'))

    expect(response).toMatchObject({ ok: false, error: { code: 'stable_pane_required' } })
  })

  it('leaves a paired caller with no Run id on the pane-bound rule', async () => {
    const response = await callAsPairedRuntime({
      id: 'paired-no-run',
      authToken: 'caller-token',
      method: 'orchestration.check',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      params: {
        terminal: 'term_peer_coord',
        terminalPaneKey: peerCoordinatorPaneKey,
        remoteRunMailbox: true,
        ack: 'delivery_does_not_exist'
      }
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'stale_delivery' } })
  })
})
