import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'
import { ORCHESTRATION_FEDERATION_CONTROL_METHODS } from './orchestration-federation-control'

const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const HOME_FINGERPRINT = 'home_fingerprint'

describe('federated agent-gate propagation', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(WORKER_PANE_KEY)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime:pty:1')
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      worktreeId: 'repo::worktree',
      connected: true,
      status: 'running'
    } as never)
  })

  afterEach(() => {
    runtime.stopOrchestrationFederationRelay()
    db.close()
  })

  function callMethod(
    methods: typeof ORCHESTRATION_METHODS,
    name: string,
    params: Record<string, unknown>,
    context: Record<string, unknown> = {}
  ) {
    const method = methods.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`${name} is not registered`)
    }
    return method.handler(method.params!.parse(params), { runtime, ...context } as never)
  }

  // The worker server's own view of a Dispatch whose Run lives on another Orca server.
  function createRemoteAttachment(dispatchId: string) {
    db.createRemoteDispatchAttachment({
      dispatchId,
      taskId: 'task_remote',
      homePeerFingerprint: HOME_FINGERPRINT,
      protocolVersion: 1,
      runtimeEpoch: 'home_epoch',
      mutationReceipt: {
        callerFingerprint: HOME_FINGERPRINT,
        requestId: 'req_attach_1',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash_attach_1'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      terminalHandle: 'term_remote_worker',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_remote_worker' }]
    })
    db.markRemoteAttachmentReady(dispatchId)
    return dispatchId
  }

  // The Run home's view of the same Dispatch, with the peer call stubbed.
  function createFederatedDispatch(peerObservation: Record<string, unknown>) {
    const run = db.createRun({
      objective: 'Watch a federated gate',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      runtimeEpoch: runtime.getRuntimeId(),
      federation: {
        environmentId: 'environment_peer',
        environmentName: 'peer',
        peerFingerprint: 'peer_fingerprint',
        protocolVersion: 1
      }
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_peer',
      name: 'peer',
      peerFingerprint: 'peer_fingerprint'
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      runtimeEpoch: 'peer_epoch',
      attachment: {
        state: 'ready',
        stage: 'input_accepted',
        last_error: null,
        worktree_id: 'repo::remote-worktree',
        terminal_handle: 'term_remote_worker',
        setup_state: 'not_applicable',
        effects: [],
        residualResources: []
      },
      terminal: { handle: 'term_remote_worker', connected: true },
      observation: peerObservation
    })
    return started.dispatch.id
  }

  it('emits the gate verdict from the worker server', async () => {
    const dispatchId = createRemoteAttachment('ctx_remote_gate')
    vi.spyOn(runtime, 'getTerminalAgentStatus').mockResolvedValue({
      handle: 'term_remote_worker',
      isRunningAgent: true,
      status: 'permission'
    })
    vi.spyOn(runtime, 'getTerminalWaitBlockedAt').mockReturnValue(
      Date.parse('2026-08-21T09:15:00Z')
    )

    const shown = (await callMethod(
      ORCHESTRATION_FEDERATION_CONTROL_METHODS,
      'orchestration.federationShow',
      { dispatchId },
      { authenticatedCallerFingerprint: HOME_FINGERPRINT }
    )) as { observation: Record<string, unknown> }

    expect(shown.observation).toEqual({
      status: 'running',
      exactWorker: true,
      agentStatus: 'permission',
      blockedSince: '2026-08-21T09:15:00.000Z'
    })
  })

  it('omits the verdict from the worker server rather than fabricating one', async () => {
    const dispatchId = createRemoteAttachment('ctx_remote_unknown')
    vi.spyOn(runtime, 'getTerminalAgentStatus').mockRejectedValue(new Error('terminal_gone'))

    const shown = (await callMethod(
      ORCHESTRATION_FEDERATION_CONTROL_METHODS,
      'orchestration.federationShow',
      { dispatchId },
      { authenticatedCallerFingerprint: HOME_FINGERPRINT }
    )) as { observation: Record<string, unknown> }

    expect(shown.observation).toEqual({ status: 'running', exactWorker: true })
  })

  it('carries a peer-emitted verdict through to the home worker-show', async () => {
    const dispatchId = createFederatedDispatch({
      status: 'running',
      exactWorker: true,
      agentStatus: 'permission',
      blockedSince: '2026-08-21T09:15:00.000Z'
    })

    const shown = (await callMethod(ORCHESTRATION_METHODS, 'orchestration.workerShow', {
      dispatch: dispatchId
    })) as { observation: Record<string, unknown> }

    expect(shown.observation).toMatchObject({
      agentStatus: 'permission',
      blockedSince: '2026-08-21T09:15:00.000Z'
    })
  })

  it('leaves the home with no verdict when the peer omits the fields', async () => {
    const dispatchId = createFederatedDispatch({ status: 'running', exactWorker: true })

    const shown = (await callMethod(ORCHESTRATION_METHODS, 'orchestration.workerShow', {
      dispatch: dispatchId
    })) as { observation: Record<string, unknown> }

    expect(shown.observation).not.toHaveProperty('agentStatus')
    expect(shown.observation).not.toHaveProperty('blockedSince')
  })
})
