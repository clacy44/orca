import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import type { OrchestrationError } from './orchestration-error'
import {
  requireFederatedDispatchAcceptsWorkerMail,
  summarizeQueuedWorkerMail
} from './federation-worker-mail-fence'

describe('coordinator-to-worker mail fence', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  function createFederatedDispatch(): { db: OrchestrationDb; dispatchId: string } {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const run = db.createRun({
      objective: 'Federated mail fencing',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'environment_peer',
        environmentName: 'peer',
        peerFingerprint: 'peer_fingerprint',
        protocolVersion: 2
      }
    })
    return { db, dispatchId: started.dispatch.id }
  }

  it('accepts mail for a ready Dispatch', () => {
    const { db, dispatchId } = createFederatedDispatch()
    db.markWorkerDispatchReady(dispatchId)

    expect(() => requireFederatedDispatchAcceptsWorkerMail(db, dispatchId)).not.toThrow()
  })

  it('refuses mail the relay could never push', () => {
    const { db, dispatchId } = createFederatedDispatch()

    // Why: `starting` is the pre-ready case; the relay's push gate ignores it exactly
    // like a settled Dispatch, so queueing here would strand the item.
    expect(() => requireFederatedDispatchAcceptsWorkerMail(db, dispatchId)).toThrowError(
      `Federated Dispatch ${dispatchId} is not active.`
    )
    expect(() => requireFederatedDispatchAcceptsWorkerMail(db, 'ctx_missing')).toThrowError(
      'Federated Dispatch ctx_missing is not active.'
    )
  })

  it('names the worker terminal the sender can still reach', () => {
    const { db, dispatchId } = createFederatedDispatch()
    db.updateFederatedDispatchResources({
      dispatchId,
      remoteRuntimeEpoch: 'peer_epoch',
      worktreeId: 'repo::peer-worktree',
      terminalHandle: 'term_peer_worker'
    })

    const error = captureFenceError(db, dispatchId)

    expect(error.message).toBe(`Federated Dispatch ${dispatchId} is not active.`)
    expect(error.data).toEqual({
      effectsApplied: false,
      nextSteps: [
        'Reach the worker\'s terminal directly: orca terminal send --terminal term_peer_worker --environment peer --text "<message>" --enter',
        'Start a new Dispatch for the follow-up work; this one no longer accepts coordinator mail.'
      ]
    })
  })

  it('still names a route when the peer never reported a terminal handle', () => {
    // Negative control: an unresolvable handle must not fabricate a terminal command.
    const { db, dispatchId } = createFederatedDispatch()

    const error = captureFenceError(db, dispatchId)

    expect(error.data).toEqual({
      effectsApplied: false,
      nextSteps: [
        'Start a new Dispatch for the follow-up work; this one no longer accepts coordinator mail.'
      ]
    })
  })

  function captureFenceError(
    db: OrchestrationDb,
    dispatchId: string
  ): { message: string; data: unknown } {
    try {
      requireFederatedDispatchAcceptsWorkerMail(db, dispatchId)
    } catch (error) {
      return error as OrchestrationError
    }
    throw new Error('expected the fence to refuse')
  }

  it('reports queued mail as undeliverable once the Dispatch leaves ready', () => {
    const { db, dispatchId } = createFederatedDispatch()
    db.markWorkerDispatchReady(dispatchId)
    expect(summarizeQueuedWorkerMail(db, dispatchId, 'ready')).toEqual({
      pending: 0,
      deliverable: true
    })

    db.enqueueFederationRelay({
      dispatchId,
      direction: 'to_worker',
      kind: 'control_message',
      payload: JSON.stringify({ subject: 'Follow-up', body: 'Keep going', type: 'status' })
    })

    expect(summarizeQueuedWorkerMail(db, dispatchId, 'ready')).toEqual({
      pending: 1,
      deliverable: true
    })
    expect(summarizeQueuedWorkerMail(db, dispatchId, 'succeeded')).toEqual({
      pending: 1,
      deliverable: false
    })
  })
})
