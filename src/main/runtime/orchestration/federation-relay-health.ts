import type { OrchestrationDb } from './db'
import {
  recordFederationSyncFailure,
  recordFederationSyncSuccess,
  type FederationSyncHealth
} from './federation-sync-health'

export type FederationRelaySyncOutcome =
  | { kind: 'success'; at: string }
  | { kind: 'failure'; error: unknown }

// Why one function for "settle the health" rather than a setter beside each call site: the in-memory
// value the backoff reads and the persisted value a restart reads must never disagree, and they only
// stay in step if every settle path computes both from the same previous reading.
export function recordFederationRelaySyncOutcome(args: {
  db: OrchestrationDb
  dispatchId: string
  previous: FederationSyncHealth | undefined
  outcome: FederationRelaySyncOutcome
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
  return next
}
