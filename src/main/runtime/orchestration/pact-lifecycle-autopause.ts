// S10-3 pact spec — liveness auto-pause hooks (K6/K16/K17). Split out of pact-lifecycle.ts
// (pause/resume/release) per the max-lines ratchet.
import type Database from '../../sqlite/sync-database'
import type { ThreadRow } from './types'
import type { PactPauseReason } from './pact-types'
import { auditPact, insertPactStepRow } from './pact-shared'
import { isFederatedPact } from './pact-federated-identity'
import {
  emitFederatedPactSideEffect,
  type FederatedPactEmitRuntime
} from './pact-federated-pause-resume-emit'

export type AutoPauseOutcome = {
  threadId: string
  proposerAgentId: string
  withAgentId: string
  reason: PactPauseReason
}

// Liveness auto-pause (K6/K17): a HOST row (actor_agent_id NULL) — never params.from, never a
// participant claim. Idempotent: a thread already paused is left alone (no double pause row).
function autoPauseOneThread(
  db: Database.Database,
  thread: ThreadRow,
  reason: PactPauseReason,
  runtime: FederatedPactEmitRuntime | null = null
): AutoPauseOutcome {
  if (isFederatedPact(thread)) {
    emitFederatedPactSideEffect(db, runtime, thread.id, 'pause', reason)
    return {
      threadId: thread.id,
      proposerAgentId: thread.pact_proposer_agent_id as string,
      withAgentId: thread.pact_with_agent_id as string,
      reason
    }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    // R3 (D-R136): bumps pact_flight_token like every other pact-state writer — an auto-pause
    // between emit and settle must show up in the settle guard's re-read too.
    db.prepare(
      `UPDATE threads SET pact_paused_at = datetime('now'), pact_pause_reason = ?,
         pact_flight_token = pact_flight_token + 1 WHERE id = ?`
    ).run(reason, thread.id)
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: 0,
      kind: 'pause',
      actorAgentId: null,
      actorPaneKey: null,
      actorHostId: null,
      messageId: null,
      summary: null,
      turnAfterAgentId: null,
      reasonCode: reason
    })
    auditPact(db, {
      agentId: null,
      actorPaneKey: null,
      actorHostId: null,
      verb: 'pact_auto_pause',
      outcome: 'paused',
      reasonCode: reason
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return {
    threadId: thread.id,
    proposerAgentId: thread.pact_proposer_agent_id as string,
    withAgentId: thread.pact_with_agent_id as string,
    reason
  }
}

// K6/K17 (counterpart_gone/counterpart_left/counterpart_quarantined): every ENGAGED,
// not-already-paused pact where `agentId` is a participant.
export function autoPausePactsForAgent(
  db: Database.Database,
  agentId: string,
  reason: PactPauseReason,
  runtime: FederatedPactEmitRuntime | null = null
): AutoPauseOutcome[] {
  const rows = db
    .prepare(
      `SELECT * FROM threads WHERE purged_at IS NULL AND pact_state = 'engaged'
       AND pact_paused_at IS NULL AND (pact_proposer_agent_id = ? OR pact_with_agent_id = ?)`
    )
    .all(agentId, agentId) as ThreadRow[]
  return rows.map((thread) => autoPauseOneThread(db, thread, reason, runtime))
}

// S10-21b B16b (design §4.7): the quarantine-caller's own auto-pause — every ENGAGED,
// not-already-paused federated pact whose peer is one of the resolved supersession-chain ids on
// this link. Every matched row has `pact_peer_agent_id` set (the query's own predicate), so
// `autoPauseOneThread` always takes the federated branch: exactly one coalesced pause relay per
// affected pact via B15's emitFederatedPactSideEffect, never a local-only fallback.
export function autoPausePactsForRemoteAgentChain(
  db: Database.Database,
  remoteAgentIds: readonly string[],
  linkKey: string,
  reason: PactPauseReason,
  runtime: FederatedPactEmitRuntime | null = null
): AutoPauseOutcome[] {
  if (remoteAgentIds.length === 0) {
    return []
  }
  const placeholders = remoteAgentIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT * FROM threads WHERE purged_at IS NULL AND pact_state = 'engaged'
       AND pact_paused_at IS NULL AND pact_peer_link_device_id = ?
       AND pact_peer_agent_id IN (${placeholders})`
    )
    .all(linkKey, ...remoteAgentIds) as ThreadRow[]
  return rows.map((thread) => autoPauseOneThread(db, thread, reason, runtime))
}

// K17 (thread_closed/thread_paused): a single thread's engaged pact, regardless of which side
// triggered the thread-state change.
//
// GATE-1 (S10-21b B6, design §10 row 6 — behaviour change for local pacts): widened from
// `pact_state !== 'engaged'` to `pact_state NOT IN ('engaged', 'proposed')` — a `proposed`
// (not-yet-accepted) pact is now eligible for the same thread-state auto-pause as an engaged
// one. Without this widening a thread that closes/pauses WHILE a federated propose is still
// outstanding (unanswered, `pact_state = 'proposed'`) never gets a host pause row at all, so
// `resumePactOrRequest`'s pause-condition-cleared check (pact-lifecycle.ts) has nothing to clear
// and the pact just sits proposed forever with no ledger trace of the thread-state change.
function autoPauseEligible(thread: ThreadRow): boolean {
  return thread.pact_state === 'engaged' || thread.pact_state === 'proposed'
}

export function autoPausePactOnThread(
  db: Database.Database,
  threadId: string,
  reason: PactPauseReason,
  runtime: FederatedPactEmitRuntime | null = null
): AutoPauseOutcome | null {
  const thread = db
    .prepare(`SELECT * FROM threads WHERE id = ? AND purged_at IS NULL`)
    .get(threadId) as ThreadRow | undefined
  if (!thread || !autoPauseEligible(thread) || thread.pact_paused_at !== null) {
    return null
  }
  return autoPauseOneThread(db, thread, reason, runtime)
}
