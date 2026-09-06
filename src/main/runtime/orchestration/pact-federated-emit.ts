// S10-21b B6 (design §2.3, §2.4, §2.11, Ruling 34 Addendum 6(1)) — the shared federated-pact
// emit primitive: the deferred-turn-flip sequence (§2.3's six numbered steps), parameterised
// over the ten local verbs. Every future federated call site (this commit's own `step` wiring
// in pact-step.ts; commits 8/9/13's `rebind_party`/`resync`/`resync_request` emissions) calls
// THIS function rather than re-deriving the sequence — the single place the six steps are
// written down.
//
// Scope note (brief OPEN item, chair answer 3): this commit builds the primitive and wires it
// into `step` (the one verb this commit's own tests exercise end to end, T3). `propose`,
// `accept`, `decline`, `pause`, `resume`, `release` are NOT wired into their existing local-verb
// functions here — the design's own Gate-1 line for this commit names exactly one local-pact
// behaviour change (`autoPausePactOnThread`'s predicate), so no other existing call path may
// change behaviour in this commit. Wiring those verbs' federated arms into
// proposePact/acceptPact/pausePact/resumePact/releasePactRow is left to whichever commit turns
// on the federated CLI acceptance surface for them; the primitive here is ready for that commit
// to call without re-deriving §2.3.
//
// S10-21b B7c (max-lines split): the wire-verb vocabulary and the `Within` form (design §2.3's
// steps 1-5, no transaction of its own) now live in pact-federated-emit-steps.ts — re-exported
// below so every existing importer of THIS module is unaffected. This file keeps only
// `enqueueFederatedPactVerb`, the wrapper that owns the transaction and step 6's
// OUTSIDE-transaction kick. `Within`'s precondition: the caller already holds `BEGIN IMMEDIATE`
// (SQLite cannot nest one) — resetAll's own reset settlement calls it directly, inside its own
// transaction.
import type Database from '../../sqlite/sync-database'
import {
  enqueueFederatedPactVerbWithin,
  type EnqueueFederatedPactVerbOpts,
  type EnqueueFederatedPactVerbResult,
  type FederatedPactVerb
} from './pact-federated-emit-steps'

export {
  enqueueFederatedPactVerbWithin,
  PACT_NO_LEDGER_VERBS,
  PACT_RELAY_PENDING_TOKEN,
  PACT_RESERVED_VERBS,
  PACT_TURN_CONSUMING_VERBS,
  PACT_VERB_RELAY_KIND
} from './pact-federated-emit-steps'
export type {
  EnqueueFederatedPactVerbOpts,
  EnqueueFederatedPactVerbResult,
  FederatedPactResyncPayload,
  FederatedPactVerb,
  PactRelayPendingToken
} from './pact-federated-emit-steps'

export type FederatedPactEmitRuntime = { replyOutbox?: { kick(linkDeviceId: string): void } | null }

// Wraps `Within` in the transaction plus the OUTSIDE-transaction kick (step 6's two halves).
export function enqueueFederatedPactVerb(
  db: Database.Database,
  runtime: FederatedPactEmitRuntime | null,
  threadId: string,
  verb: FederatedPactVerb,
  opts: EnqueueFederatedPactVerbOpts
): EnqueueFederatedPactVerbResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = enqueueFederatedPactVerbWithin(db, threadId, verb, opts)
    db.exec('COMMIT')
    if (result.outcome === 'enqueued') {
      runtime?.replyOutbox?.kick(result.thread.pact_peer_link_device_id as string)
    }
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
