import type { OrchestrationDb } from './db'
import { federatedDispatchInactiveRecoveryData } from './dispatch-inactive-recovery'
import { OrchestrationError } from './orchestration-error'

// Why: the relay only pushes to_worker items while the Dispatch is `ready`, so anything
// queued outside that window is never delivered and never errors. Refuse it at enqueue,
// the way the non-federated send path fences a settled Dispatch.
export function requireFederatedDispatchAcceptsWorkerMail(
  db: OrchestrationDb,
  dispatchId: string
): void {
  if (db.getWorkerDispatch(dispatchId)?.state !== 'ready') {
    const federated = db.getFederatedDispatch(dispatchId)
    throw new OrchestrationError(
      'dispatch_inactive',
      `Federated Dispatch ${dispatchId} is not active.`,
      federatedDispatchInactiveRecoveryData({
        terminalHandle: federated?.remote_terminal_handle,
        environmentName: federated?.environment_name
      })
    )
  }
}

// Why: items queued while the Dispatch was still ready can be stranded by a settlement
// that lands first; counting them keeps that visible instead of silently undelivered.
export function summarizeQueuedWorkerMail(
  db: OrchestrationDb,
  dispatchId: string,
  workerState: string
): { pending: number; deliverable: boolean } {
  return {
    pending: db.listPendingFederationRelay(dispatchId, 'to_worker').length,
    deliverable: workerState === 'ready'
  }
}
