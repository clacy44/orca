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
import type Database from '../../sqlite/sync-database'
import {
  applyPactPauseResumeState,
  auditPact,
  insertPactStepRow,
  requireThread
} from './pact-shared'
import { isFederatedPact } from './pact-federated-identity'
import { enqueueFederatedPactVerb, type FederatedPactEmitRuntime } from './pact-federated-emit'

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
  const pauseReason = verb === 'pause' ? (reasonCode ?? 'operator') : null
  let relayed = true
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
      return
    }
  } catch (err) {
    // The pact's OWN pause/resume must land locally even when the relay precondition (a live
    // peer_link_bindings row, a fully-anchored thread) is broken — containment cannot be made to
    // depend on link-binding health. Loud degradation: audited, never silent (per charter).
    relayed = false
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
      reasonCode: err instanceof Error ? err.message : String(err)
    })
  }
  if (relayed) {
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
}
