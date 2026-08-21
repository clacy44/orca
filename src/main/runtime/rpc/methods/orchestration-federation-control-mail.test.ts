import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../../../shared/agent-prompt-injection'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { authenticatedCallerFingerprint } from '../orchestration-mutation-executor'
import { ORCHESTRATION_METHODS } from './orchestration'

describe('orchestration federation control mail', () => {
  const homeToken = 'run-home-device-token'
  const workerToken = 'worker-local-token'
  const workerPeerFingerprint = 'worker-peer'
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const processIncarnation = 'worker-runtime:pty:1'
  const workerWorktreeId = 'repo-1::/tmp/worker-worktree'
  const workerLeafId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher
  let dispatchId: string
  let runId: string

  beforeEach(() => {
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    vi.spyOn(workerRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? workerPaneKey : null
    )
    vi.spyOn(workerRuntime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? processIncarnation : null
    )
    workerDispatcher = new RpcDispatcher({
      runtime: workerRuntime,
      methods: ORCHESTRATION_METHODS
    })

    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_worker',
        name: 'worker',
        peerFingerprint: workerPeerFingerprint
      }),
      call: async (_selector, method, params, _timeoutMs, envelope) => {
        if (method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: workerRuntime.getStatus(),
            _meta: { runtimeId: workerRuntime.getRuntimeId() }
          }
        }
        const response = (await workerDispatcher.dispatch({
          id: `remote_${method}`,
          authToken: homeToken,
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId
        })) as RuntimeRpcResponse<unknown>
        return response
      }
    }
    homeDb = new OrchestrationDb(':memory:')
    homeRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : null
    )
    homeDispatcher = new RpcDispatcher({
      runtime: homeRuntime,
      methods: ORCHESTRATION_METHODS
    })

    const run = homeDb.createRun({
      objective: 'Federated control mail',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    })
    runId = run.id
    const task = homeDb.createTask({ spec: 'Wait for coordinator guidance', runId })
    const started = homeDb.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'environment_worker',
        environmentName: 'worker',
        peerFingerprint: workerPeerFingerprint,
        protocolVersion: 2
      }
    })
    dispatchId = started.dispatch.id
    homeDb.markWorkerDispatchReady(dispatchId)

    const homeFingerprint = authenticatedCallerFingerprint({
      id: 'home',
      authToken: homeToken,
      method: 'orchestration.federationImport'
    })
    workerDb.createRemoteDispatchAttachment({
      dispatchId,
      taskId: task.id,
      homePeerFingerprint: homeFingerprint,
      protocolVersion: 2,
      runtimeEpoch: workerRuntime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: homeFingerprint,
        requestId: 'attach-worker',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach-worker-payload'
      }
    })
    workerDb.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: workerPaneKey,
      processIncarnation,
      worktreeId: 'repo::worker',
      terminalHandle: 'term_worker',
      setupState: 'not_applicable',
      effects: []
    })
    workerDb.markRemoteAttachmentReady(dispatchId)
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    homeDb.close()
    workerDb.close()
  })

  it('routes an exact Dispatch message through the durable relay', async () => {
    vi.spyOn(homeRuntime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    const sent = await homeDispatcher.dispatch({
      id: 'send-control',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'send-control-request',
      method: 'orchestration.send',
      params: {
        from: 'term_coord',
        to: `dispatch:${dispatchId}`,
        subject: 'Continue',
        body: 'Run the focused follow-up.',
        type: 'status'
      }
    })

    expect(sent).toMatchObject({
      ok: true,
      result: { relay: { dispatchId, accepted: true } }
    })
    expect(homeDb.listPendingFederationRelay(dispatchId, 'to_worker')).toHaveLength(1)

    await homeRuntime.syncOrchestrationFederation()
    const checked = await workerDispatcher.dispatch(checkRequest('check-imported'))

    expect(checked).toMatchObject({
      ok: true,
      result: {
        dispatchId,
        count: 1,
        messages: [
          {
            to_handle: `dispatch:${dispatchId}`,
            subject: 'Continue',
            body: 'Run the focused follow-up.'
          }
        ]
      }
    })
    expect(homeDb.listPendingFederationRelay(dispatchId, 'to_worker')).toHaveLength(0)
  })

  it('wakes a remote worker waiter when control mail imports', async () => {
    const waiting = workerDispatcher.dispatch(checkRequest('wait-for-control', true))
    await Promise.resolve()

    const imported = await workerDispatcher.dispatch(
      importRequest('import-control', 1, 'relay-control')
    )

    expect(imported).toMatchObject({
      ok: true,
      result: { acknowledgedThrough: 1, imported: 1 }
    })
    await expect(waiting).resolves.toMatchObject({
      ok: true,
      result: {
        dispatchId,
        count: 1,
        messages: [{ id: 'relay-control', subject: 'Continue' }]
      }
    })
  })

  it('accepts a repeated import after a lost acknowledgment without duplicating mail', async () => {
    const first = await workerDispatcher.dispatch(importRequest('first-import', 1, 'relay-control'))
    const repeated = await workerDispatcher.dispatch(
      importRequest('repeated-import', 1, 'different-message-id')
    )

    expect(first).toMatchObject({ ok: true, result: { imported: 1 } })
    expect(repeated).toMatchObject({ ok: true, result: { imported: 0 } })
    expect(workerDb.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(1)
  })

  it('does not deliver pending control mail after worker completion', async () => {
    vi.spyOn(homeRuntime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    await homeDispatcher.dispatch({
      id: 'send-stale-control',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'send-stale-control-request',
      method: 'orchestration.send',
      params: {
        from: 'term_coord',
        to: `dispatch:${dispatchId}`,
        subject: 'Stale follow-up',
        body: 'This must not arrive after completion.',
        type: 'status'
      }
    })
    const waiting = workerDispatcher.dispatch(checkRequest('wait-before-completion', true, 30))
    await Promise.resolve()

    const taskId = homeDb.getDispatchContextById(dispatchId)!.task_id
    workerDb.enqueueFederationRelay({
      dispatchId,
      direction: 'to_home',
      kind: 'worker_done',
      payload: JSON.stringify({
        from: `dispatch:${dispatchId}`,
        subject: 'Done',
        body: 'Completed before the follow-up arrived.',
        type: 'worker_done',
        priority: 'normal',
        threadId: null,
        payload: JSON.stringify({
          taskId,
          dispatchId,
          outcome: 'succeeded',
          filesModified: []
        })
      }),
      settleRemoteOutcome: 'succeeded'
    })

    await homeRuntime.syncOrchestrationFederation()

    expect(homeDb.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
    expect(workerDb.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(0)
    expect(homeDb.listPendingFederationRelay(dispatchId, 'to_worker')).toHaveLength(1)
    await expect(
      workerDispatcher.dispatch(importRequest('late-direct-import', 1, 'late-control'))
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'dispatch_inactive',
        message: `Remote Dispatch ${dispatchId} is not active.`,
        // Why no --environment: this refusal is raised by the runtime that owns the pane.
        data: {
          effectsApplied: false,
          nextSteps: [
            'Reach the worker\'s terminal directly: orca terminal send --terminal term_worker --text "<message>" --enter',
            'Start a new Dispatch for the follow-up work; this one no longer accepts coordinator mail.'
          ]
        }
      }
    })
    await expect(waiting).resolves.toMatchObject({
      ok: true,
      result: { count: 0 }
    })
  })

  it('relays a coordinator reply while the federated Dispatch is ready', async () => {
    vi.spyOn(homeRuntime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    const asked = homeDb.createQuestion({
      runId,
      dispatchId,
      askerHandle: `dispatch:${dispatchId}`,
      question: 'Which base branch?'
    })

    await expect(
      homeDispatcher.dispatch(replyRequest('reply-ready', asked.question.message_id, 'main'))
    ).resolves.toMatchObject({ ok: true })
    expect(homeDb.listPendingFederationRelay(dispatchId, 'to_worker')).toMatchObject([
      { kind: 'reply' }
    ])
  })

  it('refuses a coordinator reply once the federated Dispatch is no longer ready', async () => {
    vi.spyOn(homeRuntime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    const asked = homeDb.createQuestion({
      runId,
      dispatchId,
      askerHandle: `dispatch:${dispatchId}`,
      question: 'Which base branch?'
    })
    // Why: stands in for any settlement that leaves the question row pending — the relay
    // would accept the item and never push it.
    const settled = { ...homeDb.getWorkerDispatch(dispatchId)!, state: 'stopped' as const }
    vi.spyOn(homeDb, 'getWorkerDispatch').mockReturnValue(settled)

    await expect(
      homeDispatcher.dispatch(replyRequest('reply-settled', asked.question.message_id, 'main'))
    ).resolves.toMatchObject({ ok: false, error: { code: 'dispatch_inactive' } })
    expect(homeDb.listPendingFederationRelay(dispatchId, 'to_worker')).toHaveLength(0)
    expect(homeDb.getQuestion(asked.question.message_id)?.status).toBe('pending')
  })

  it('wakes only waiters whose filter matches an imported control message', async () => {
    const escalationWaiter = workerDispatcher.dispatch(
      checkRequest('wait-escalation', true, 1_000, 'escalation')
    )
    const statusWaiter = workerDispatcher.dispatch(checkRequest('wait-status', true, 30, 'status'))
    await Promise.resolve()

    await workerDispatcher.dispatch(
      importRequest('import-escalation', 1, 'relay-escalation', 'escalation')
    )

    await expect(escalationWaiter).resolves.toMatchObject({
      ok: true,
      result: {
        count: 1,
        messages: [{ id: 'relay-escalation', type: 'escalation' }]
      }
    })
    await expect(statusWaiter).resolves.toMatchObject({
      ok: true,
      result: { count: 0, timedOut: true }
    })
  })

  it('points the peer worker pane at imported coordinator mail exactly once', async () => {
    vi.useFakeTimers()
    try {
      const write = await attachLiveWorkerPane()

      await expect(
        workerDispatcher.dispatch(importRequest('import-pointed', 1, 'relay-pointed'))
      ).resolves.toMatchObject({ ok: true, result: { imported: 1 } })
      await Promise.resolve()

      expect(write).toHaveBeenCalledWith(
        'pty-worker',
        '\nYou have 1 orchestration message. Run `orca orchestration check`.\n'
      )
      expect(write).not.toHaveBeenCalledWith(
        'pty-worker',
        expect.stringContaining('Run the focused follow-up.')
      )
      await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS)
      expect(write).toHaveBeenCalledWith('pty-worker', '\r')

      write.mockClear()
      await expect(
        workerDispatcher.dispatch(importRequest('import-repeated', 1, 'different-message-id'))
      ).resolves.toMatchObject({ ok: true, result: { imported: 0 } })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_500)

      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not point a peer pane whose worker process re-spawned under the attachment', async () => {
    vi.useFakeTimers()
    try {
      const write = await attachLiveWorkerPane()
      // Negative control: `check` answers dispatch_inactive here, so the push must be silent.
      vi.spyOn(workerRuntime, 'getTerminalProcessIncarnation').mockReturnValue(
        'worker-runtime:pty:2'
      )

      await expect(
        workerDispatcher.dispatch(importRequest('import-reminted', 1, 'relay-reminted'))
      ).resolves.toMatchObject({ ok: true, result: { imported: 1 } })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_500)

      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not point a peer worker that already settled', async () => {
    vi.useFakeTimers()
    try {
      const write = await attachLiveWorkerPane()
      // Why insert directly: federationImport already refuses a settled attachment, so
      // the row this control needs is one that landed before the worker stopped.
      workerDb.insertMessage({
        from: 'term_coord',
        to: `dispatch:${dispatchId}`,
        subject: 'Continue',
        body: 'Run the focused follow-up.',
        type: 'status'
      })
      // Negative control: the preamble's stop-after-settlement rule depends on this.
      workerDb.beginRemoteAttachmentStop(dispatchId)
      workerDb.settleRemoteAttachmentStop(dispatchId)

      workerRuntime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_500)

      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  async function attachLiveWorkerPane(): Promise<ReturnType<typeof vi.fn>> {
    const write = vi.fn().mockReturnValue(true)
    workerRuntime.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => null
    } as never)
    workerRuntime.attachWindow(1)
    workerRuntime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: workerWorktreeId,
          title: 'Codex',
          activeLeafId: workerLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: workerWorktreeId,
          leafId: workerLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        }
      ]
    })
    const [pane] = (await workerRuntime.listTerminals()).terminals
    // Why re-stamp the handle: the attachment is written before this test mints a pane,
    // and the peer resolves the mailbox through exactly the handle it recorded.
    workerDb.recordRemoteAttachmentStage({
      dispatchId,
      stage: 'input_accepted',
      terminalHandle: pane.handle
    })
    // Why re-point the identity mocks: this pane IS the attached worker process, so it
    // answers with the pane key and incarnation the attachment pinned at start.
    vi.spyOn(workerRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === pane.handle || handle === 'term_worker' ? workerPaneKey : null
    )
    vi.spyOn(workerRuntime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === pane.handle || handle === 'term_worker' ? processIncarnation : null
    )
    workerRuntime.onPtyData('pty-worker', '\u001b]0;Codex working\u0007', 100)
    workerRuntime.onPtyData('pty-worker', '\u001b]0;Codex done\u0007', 101)
    write.mockClear()
    return write
  }

  function checkRequest(id: string, wait = false, timeoutMs = 5_000, types?: string): RpcRequest {
    return {
      id,
      authToken: workerToken,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      method: 'orchestration.check',
      params: {
        terminal: 'term_worker',
        wait,
        timeoutMs,
        types
      }
    }
  }

  function replyRequest(id: string, messageId: string, body: string): RpcRequest {
    return {
      id,
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: `${id}-request`,
      method: 'orchestration.reply',
      params: { from: 'term_coord', id: messageId, body }
    }
  }

  function importRequest(
    id: string,
    sequence: number,
    messageId: string,
    type = 'status'
  ): RpcRequest {
    return {
      id,
      authToken: homeToken,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      method: 'orchestration.federationImport',
      params: {
        dispatchId,
        items: [
          {
            dispatch_id: dispatchId,
            direction: 'to_worker',
            sequence,
            message_id: messageId,
            kind: 'control_message',
            payload: JSON.stringify({
              from: `run:${runId}`,
              subject: 'Continue',
              body: 'Run the focused follow-up.',
              type,
              priority: 'normal',
              threadId: null,
              payload: null
            })
          }
        ]
      }
    }
  }
})
