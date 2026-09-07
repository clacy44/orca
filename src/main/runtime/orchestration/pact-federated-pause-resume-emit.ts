// S10-21b B15 (design §2.7, CHAIR RULING 21b-E7): the ONE relay hook for every host-driven
// pause/resume transition on a federated pact — the single writer of the whole verb (`threads`
// state + `pact_steps` ledger row + message + `peer_reply_outbox` item), routed through
// enqueueFederatedPactVerb exactly as B6 did for `step` (pact-step.ts). A local (non-federated)
// pact is a no-op — the caller's own local UPDATE/insertPactStepRow/auditPact path handles it.
//
// Coalescing (Addendum 6(9)/N10, T32): pause/resume coalesce CROSS-KIND — at most one unsettled
// side-effect item per pact, carrying the CURRENT absolute state at call time, never two
// outstanding items from rapid local flips.
//
// Signature deviation from the design's literal 5-arg citation (chair ruling 21b-E7): pausePact/
// resumePact (pact-lifecycle.ts) are OPERATOR verbs with a real caller identity, unlike the four
// purely host-driven call sites (gone-transition, quarantine, threads.leave, 21a's restore-
// resume) the design's own §2.7 list names — `actor` is optional and defaults to a host row
// (agentId/paneKey/hostId null), so every host-driven caller (incl. B16b) still calls this with
// the brief's own 5 positional args.
//
// S10-21b B17 (D-R137 D-R138 F5, item 10/16): the base implementation caught ANY error from the
// emit primitive into a bare local-only fallback (three separate auto-commits, violating
// INV-PACT-SINGLE-WRITER) and returned bare (no fallback at all) on a gate `refused` outcome,
// leaving the pause NOT applied and no audit row. Fix: check the two real preconditions (anchors
// present, a live binding) BEFORE calling the primitive and fall back ONLY on those (one BEGIN
// IMMEDIATE for all three writes); a `refused` outcome now goes through the same fallback
// instead of a bare return.
//
// S10-21b B21 (D-D3 redesign — 21b-E8 REVOKED, one minter): pause/resume no longer have a
// `pact_relay_pending` token or a drain — the coalescer bounds a pact to <= 1 queued
// pause/resume row, so `enqueueReplyOutbox`'s cap admission is EXEMPT for them
// (reply-outbox-store.ts) and `LinkBindingCapError` is unreachable-by-construction on this
// path. The `catch (LinkBindingCapError)` branch below stays as a fail-safe carve-out only —
// applied locally, nothing owed, nothing relayed — for a defect that would have to reintroduce
// the cap on this insert to ever fire; its audit row is the durable trace if it ever does.
import type Database from '../../sqlite/sync-database'
import {
  applyPactPauseResumeState,
  auditPact,
  insertPactStepRow,
  requireThread
} from './pact-shared'
import { isFederatedPact } from './pact-federated-identity'
import { enqueueFederatedPactVerb, type FederatedPactEmitRuntime } from './pact-federated-emit'
import { PACT_PAUSE_REASONS } from './pact-types'
import { getPeerLinkBinding, LinkBindingCapError } from './link-binding-store'

const PACT_PAUSE_REASON_SET: ReadonlySet<string> = new Set(PACT_PAUSE_REASONS)

export type { FederatedPactEmitRuntime }

export type FederatedPactSideEffectActor = {
  agentId: string | null
  paneKey: string | null
  hostId: string | null
}

const HOST_ACTOR: FederatedPactSideEffectActor = { agentId: null, paneKey: null, hostId: null }

export function emitFederatedPactSideEffect(
  db: Database.Database,
  runtime: FederatedPactEmitRuntime | null,
  threadId: string,
  verb: 'pause' | 'resume',
  reasonCode: string | null,
  actor: FederatedPactSideEffectActor = HOST_ACTOR
): void {
  const thread = requireThread(db, threadId)
  if (!isFederatedPact(thread)) {
    return
  }
  const pausedAt: 'now' | null = verb === 'pause' ? 'now' : null
  // S10-21b B17 (D-R137 F8): `reasonCode` doubles as the LEDGER's free-text reason_code (every
  // existing caller passes a value that also happens to be a valid `pact_pause_reason`, e.g.
  // 'counterpart_gone') — but a caller may need a MORE SPECIFIC ledger reason_code than the
  // frozen six-value CHECK on `threads.pact_pause_reason` allows (§2.6(c) step 4's
  // declared-deviation pattern: pause_reason='operator', reason_code='pact_ledger_capped').
  // `pauseReason` (the constrained column) falls back to 'operator' whenever reasonCode is not
  // itself one of the six values; `reasonCode` unchanged is still what lands on the ledger row.
  const pauseReason =
    verb === 'pause'
      ? reasonCode !== null && PACT_PAUSE_REASON_SET.has(reasonCode)
        ? reasonCode
        : 'operator'
      : null

  // The two real preconditions `enqueueFederatedPactVerbWithin` itself hard-requires (its own
  // "internal error" throws otherwise) — checked HERE so a broken precondition takes the
  // fallback below rather than an internal-error exception the caller cannot classify.
  const anchorsPresent =
    thread.pact_peer_link_device_id !== null &&
    thread.pact_peer_environment_id !== null &&
    thread.pact_peer_agent_id !== null
  const binding = anchorsPresent
    ? getPeerLinkBinding(db, thread.pact_peer_link_device_id as string)
    : null
  const preconditionsOk = anchorsPresent && binding !== null

  // S10-21b B21: no `pendingToken` — applied locally, nothing owed, nothing relayed (one
  // minter; the fallback never marks anything for a later drain to send).
  const localFallback = (auditDetail: string): void => {
    db.exec('BEGIN IMMEDIATE')
    try {
      applyPactPauseResumeState(db, thread.id, pausedAt, pauseReason)
      insertPactStepRow(db, {
        threadId: thread.id,
        ordinal: 0,
        kind: verb,
        actorAgentId: actor.agentId,
        actorPaneKey: actor.paneKey,
        actorHostId: actor.hostId,
        messageId: null,
        summary: null,
        turnAfterAgentId: verb === 'resume' ? thread.pact_turn_agent_id : null,
        reasonCode
      })
      auditPact(db, {
        agentId: actor.agentId,
        actorPaneKey: actor.paneKey,
        actorHostId: actor.hostId,
        verb: 'pact_federated_side_effect_relay_failed',
        outcome: 'local_only',
        reasonCode: auditDetail
      })
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (!preconditionsOk) {
    localFallback(anchorsPresent ? 'no_live_binding' : 'missing_peer_anchor')
    return
  }

  try {
    const result = enqueueFederatedPactVerb(db, runtime, threadId, verb, {
      actorAgentId: actor.agentId,
      actorPaneKey: actor.paneKey,
      actorHostId: actor.hostId,
      runId: 'host',
      reasonCode,
      turnAfterAgentId: verb === 'resume' ? thread.pact_turn_agent_id : null,
      threadStateMutation: { pausedAt, pauseReason },
      coalesceAcrossRelayKinds: ['pact_pause', 'pact_resume']
    })
    if (result.outcome === 'refused') {
      localFallback('gate_refused')
      return
    }
  } catch (err) {
    if (err instanceof LinkBindingCapError) {
      // S10-21b B21: unreachable-by-construction — the coalescer-bounded cap exemption
      // (reply-outbox-store.ts) means this insert can no longer throw `LinkBindingCapError`
      // for pause/resume. Retained as a fail-safe carve-out only: land the pause/resume
      // LOCALLY, with the REAL reason and actor, in one transaction — nothing owed, nothing
      // relayed. Its audit row is the durable trace if this ever fires.
      localFallback('relay_cap')
      return
    }
    // Every other error (a genuine DB fault, a coding error) propagates — it must never be
    // silently absorbed into a local-only pause that looks identical to a healthy relay.
    throw err
  }
  // Parity with every local pause/resume path, each of which audits its own transition.
  auditPact(db, {
    agentId: actor.agentId,
    actorPaneKey: actor.paneKey,
    actorHostId: actor.hostId,
    verb: verb === 'pause' ? 'pact_pause' : 'pact_resume',
    outcome: verb === 'pause' ? 'paused' : 'resumed',
    reasonCode
  })
}
