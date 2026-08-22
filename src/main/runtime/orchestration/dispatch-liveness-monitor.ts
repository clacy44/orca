import type { OrchestrationDb } from './db'
import type { FederationSyncHealth } from './federation-sync-health'
import { RUNTIME_NOTIFICATION_MESSAGE_TYPE } from './types'
import {
  selectDispatchLivenessBreaches,
  type DispatchLivenessBreach
} from './dispatch-liveness-window'

// Why one sweep interval and not a timer per Dispatch: the evaluation is a single indexed query
// over live Dispatches, and a per-Dispatch timer would have to be armed, re-armed after a restart
// and disarmed on every settlement path — three more places to leak one.
export const DISPATCH_LIVENESS_SWEEP_INTERVAL_MS = 60_000

// Why a sender that is not the worker: A1 §12 shares the escalation channel with worker-raised
// escalations, so the coordinator must be able to tell at a glance that the runtime said this and
// not the agent. payload.origin says the same thing to a machine reader.
export const DISPATCH_LIVENESS_BREACH_SENDER = 'runtime'

export type DispatchLivenessBreachNotifier = {
  notifyMessageArrived: (handle: string, messageType?: string) => void
  getOrchestrationFederationSyncHealth: (dispatchId: string) => FederationSyncHealth | null
}

// Why no clock-skew handling anywhere below: every timestamp compared here is home-stamped —
// last_heartbeat_at by the messages table's datetime('now') on the local send path and by the
// home's own new Date() at federated import, blocked_since by the home's `ask` / `check` handler.
// A peer's clock never enters the comparison, so a peer clocked hours away cannot move the window.
export function sweepDispatchLivenessBreaches(args: {
  db: OrchestrationDb
  runtime: DispatchLivenessBreachNotifier
  now?: number
}): DispatchLivenessBreach[] {
  const now = args.now ?? Date.now()
  const breachedAt = new Date(now).toISOString()
  const emitted: DispatchLivenessBreach[] = []
  for (const breach of selectDispatchLivenessBreaches(
    args.db.listDispatchLivenessCandidates(),
    now
  )) {
    if (!args.db.markDispatchLivenessBreached(breach.dispatchId, breachedAt)) {
      continue
    }
    const syncHealth = args.runtime.getOrchestrationFederationSyncHealth(breach.dispatchId)
    const message = args.db.insertMessage({
      runId: breach.runId,
      from: DISPATCH_LIVENESS_BREACH_SENDER,
      to: `run:${breach.runId}`,
      subject: `Worker ${breach.dispatchId} missed its liveness window`,
      body:
        `No heartbeat from Dispatch ${breach.dispatchId} on task ${breach.taskId} for ` +
        `${Math.round(breach.effectiveSilenceMs / 60_000)} min against a ` +
        `${Math.round(breach.windowMs / 60_000)} min window. The Dispatch is untouched; ` +
        `read the worker before deciding.`,
      type: RUNTIME_NOTIFICATION_MESSAGE_TYPE,
      priority: 'high',
      payload: JSON.stringify({
        origin: 'runtime',
        kind: 'liveness_breach',
        dispatchId: breach.dispatchId,
        taskId: breach.taskId,
        lastHeartbeatAt: breach.lastHeartbeatAt,
        windowMs: breach.windowMs,
        // Why only when federated: it is the discriminator between "the worker went silent" and
        // "the transport did" (A1 §9), and a local Dispatch has no transport to blame.
        ...(syncHealth ? { syncHealth } : {})
      })
    })
    args.runtime.notifyMessageArrived(message.to_handle, message.type)
    emitted.push(breach)
  }
  return emitted
}
