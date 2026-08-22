import type { OrchestrationDb } from './db'
import {
  classifyFederationRelayHealthTransition,
  recordFederationSyncFailure,
  recordFederationSyncSuccess,
  type FederationRelayHealthTransition,
  type FederationSyncHealth
} from './federation-sync-health'
import { postRuntimeNotification, type RuntimeNotificationSink } from './runtime-notification'

export type FederationRelaySyncOutcome =
  | { kind: 'success'; at: string }
  | { kind: 'failure'; error: unknown }

// Why one function for "settle the health" rather than a setter beside each call site: the in-memory
// value the backoff reads and the persisted value a restart reads must never disagree, and they only
// stay in step if every settle path computes both from the same previous reading.
export function recordFederationRelaySyncOutcome(args: {
  db: OrchestrationDb
  runtime: RuntimeNotificationSink
  dispatchId: string
  previous: FederationSyncHealth | undefined
  outcome: FederationRelaySyncOutcome
  thresholdFailures?: number
}): FederationSyncHealth {
  const next =
    args.outcome.kind === 'success'
      ? recordFederationSyncSuccess(args.outcome.at)
      : recordFederationSyncFailure(args.previous, args.outcome.error)
  // Why best-effort: the row is a diagnostic, and a write that fails must not turn a relay pull that
  // actually landed into a failed one. The in-memory value still drives this process's backoff.
  try {
    args.db.recordFederatedDispatchSyncHealth(args.dispatchId, next)
  } catch (error) {
    console.warn(
      `[orchestration] Federation sync health persist failed for ${args.dispatchId}:`,
      error
    )
  }
  const transition = classifyFederationRelayHealthTransition(
    args.previous,
    next,
    args.thresholdFailures
  )
  if (transition) {
    postFederationRelayHealthNotice({ ...args, transition, health: next })
  }
  return next
}

// Why the notice is swallowed rather than rethrown: it rides the promise the relay tick awaits, and
// a throw here would mark a pull that actually landed as the next consecutive failure.
function postFederationRelayHealthNotice(args: {
  db: OrchestrationDb
  runtime: RuntimeNotificationSink
  dispatchId: string
  transition: Exclude<FederationRelayHealthTransition, null>
  health: FederationSyncHealth
  previous: FederationSyncHealth | undefined
}): void {
  try {
    // Why the target lookup can come back empty: only an unsettled federated Dispatch has a
    // coordinator who can still act, and the relay stays armed past settlement to drain the peer's
    // queue — so an outage that spans a settlement must not escalate afterwards.
    const target = args.db.getFederatedRelayNoticeTarget(args.dispatchId)
    if (!target) {
      return
    }
    const notice = describeFederationRelayHealth(args.transition, args.dispatchId, {
      environmentName: target.environmentName,
      health: args.health,
      failures: args.previous?.consecutiveFailures ?? args.health.consecutiveFailures
    })
    postRuntimeNotification({
      db: args.db,
      runtime: args.runtime,
      runId: target.runId,
      subject: notice.subject,
      body: notice.body,
      payload: {
        kind: notice.kind,
        dispatchId: args.dispatchId,
        taskId: target.taskId,
        environmentName: target.environmentName,
        lastError: args.health.lastError,
        lastSyncAt: args.health.lastSyncAt,
        consecutiveFailures: args.health.consecutiveFailures
      }
    })
  } catch (error) {
    console.warn(
      `[orchestration] Federation relay health notice failed for ${args.dispatchId}:`,
      error
    )
  }
}

// Why the body names the transport explicitly: this is the discriminator A1 section 9 asks for, and
// a coordinator that reads it as "my worker is stuck" will read the worker instead of the link.
function describeFederationRelayHealth(
  transition: Exclude<FederationRelayHealthTransition, null>,
  dispatchId: string,
  context: { environmentName: string; health: FederationSyncHealth; failures: number }
): { kind: string; subject: string; body: string } {
  if (transition === 'recovered') {
    return {
      kind: 'relay_recovered',
      subject: `Federation relay to ${context.environmentName} is syncing again`,
      body:
        `The home is reaching ${context.environmentName} again after ${context.failures} ` +
        `consecutive failures, so Dispatch ${dispatchId} is being pulled as normal. Anything the ` +
        'worker sent during the outage arrives on the next Delivery.'
    }
  }
  return {
    kind: 'relay_unreachable',
    subject: `Federation relay to ${context.environmentName} is not reaching Dispatch ${dispatchId}`,
    body:
      `The home has failed to sync Dispatch ${dispatchId} with ${context.environmentName} ` +
      `${context.health.consecutiveFailures} times in a row (last error: ` +
      `${context.health.lastError ?? 'unknown'}; last successful sync: ` +
      `${context.health.lastSyncAt ?? 'never'}). This is the transport, not a verdict about the ` +
      'worker: it may still be working, but nothing it says can reach you until the link is back. ' +
      'The Dispatch is untouched.'
  }
}
