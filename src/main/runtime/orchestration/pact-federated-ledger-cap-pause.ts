// S10-21b B14 (design §4.6(a)) — split out of pact-lifecycle.ts (max-lines ratchet): the
// per-pact `pact_steps` cap's own auto-pause. Over cap refuses `pact_ledger_capped` AND
// auto-pauses THAT PACT ONLY (every other federated pact on the same link is unaffected, closing
// N5's cross-pact denial). `pact_pause_reason` stays 'operator' (its CHECK is frozen at six
// values); the ledger row's own `reason_code` is 'pact_ledger_capped' — the same
// declared-deviation pattern §2.6(c) step 4 already uses.
//
// S10-21b B17 (D-R137 F8): this pact is federated by construction — it only ever runs on the
// inbound propose-apply path (refuseIfPactStepsOverCap). The base implementation wrote the
// pause directly (UPDATE + insertPactStepRow + auditPact), bypassing `emitFederatedPactSideEffect`
// entirely — so the peer was never told about the cap, contrary to §2.7 and ruling 21b-E7's
// "every local pause/resume path". It also cleared `pact_turn_in_flight_at`, releasing OUR OWN
// unsettled relay's marker for an unrelated cap event without bumping `pact_flight_token`, so a
// concurrent settle could still read fresh and apply its turn flip onto a now-paused pact. Fix:
// route through the one relay hook, and drop the marker clear (emitFederatedPactSideEffect's own
// state mutation owns pact_paused_at/pact_pause_reason; it never touches the in-flight marker).
import type Database from '../../sqlite/sync-database'
import { requireThread } from './pact-shared'
import {
  emitFederatedPactSideEffect,
  type FederatedPactEmitRuntime
} from './pact-federated-pause-resume-emit'

export function autoPauseThreadForLedgerCap(
  db: Database.Database,
  threadId: string,
  runtime: FederatedPactEmitRuntime | null = null
): void {
  // Idempotent per episode (base behaviour's `WHERE pact_paused_at IS NULL` guard,
  // `emitFederatedPactSideEffect` has no guard of its own): a retried over-cap write must not
  // re-pause, re-relay, or re-bump the flight token every time.
  const thread = requireThread(db, threadId)
  if (thread.pact_paused_at !== null) {
    return
  }
  emitFederatedPactSideEffect(db, runtime, threadId, 'pause', 'pact_ledger_capped')
}
