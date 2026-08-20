import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

describe('federated worker-show sync health', () => {
  const databases: OrchestrationDb[] = []
  const runtimes: OrcaRuntimeService[] = []

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) {
      runtime.stopOrchestrationFederationRelay()
    }
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  function createReadyFederatedDispatch() {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    runtimes.push(runtime)
    const run = db.createRun({
      objective: 'Watch the relay',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
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
      observation: { status: 'running', exactWorker: true }
    })
    return { db, runtime, dispatchId: started.dispatch.id }
  }

  function workerShow(runtime: OrcaRuntimeService, dispatchId: string) {
    const method = ORCHESTRATION_METHODS.find((entry) => entry.name === 'orchestration.workerShow')
    if (!method) {
      throw new Error('workerShow method is not registered')
    }
    return method.handler(method.params!.parse({ dispatch: dispatchId }), { runtime } as never)
  }

  it('reports the failing relay while state and stage still read green', async () => {
    const { runtime, dispatchId } = createReadyFederatedDispatch()
    vi.spyOn(runtime, 'getOrchestrationFederationSyncHealth').mockReturnValue({
      lastSyncAt: '2026-08-20T00:00:00.000Z',
      lastError: 'peer_changed: Saved environment peer now identifies a different Orca server.',
      consecutiveFailures: 7
    })

    await expect(workerShow(runtime, dispatchId)).resolves.toMatchObject({
      worker: { state: 'ready', stage: 'input_accepted' },
      sync: {
        lastSyncAt: '2026-08-20T00:00:00.000Z',
        lastError: 'peer_changed: Saved environment peer now identifies a different Orca server.',
        consecutiveFailures: 7
      }
    })
  })

  it('reports a null relay health rather than omitting the field', async () => {
    const { runtime, dispatchId } = createReadyFederatedDispatch()

    await expect(workerShow(runtime, dispatchId)).resolves.toMatchObject({ sync: null })
  })

  it('counts coordinator mail still queued for the worker', async () => {
    const { db, runtime, dispatchId } = createReadyFederatedDispatch()
    db.enqueueFederationRelay({
      dispatchId,
      direction: 'to_worker',
      kind: 'control_message',
      payload: JSON.stringify({ subject: 'Follow-up', body: 'Keep going', type: 'status' })
    })

    await expect(workerShow(runtime, dispatchId)).resolves.toMatchObject({
      workerMail: { pending: 1, deliverable: true }
    })
  })
})
