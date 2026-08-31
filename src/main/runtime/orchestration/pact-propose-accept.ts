// S10-3 pact spec — propose/accept/decline. Split out of pact-lifecycle.ts (pause/resume/
// release) and pact-step.ts (the step ledger writer) per the max-lines ratchet.
import type Database from '../../sqlite/sync-database'
import type { ThreadRow } from './types'
import {
  auditPact,
  insertPactStepRow,
  otherPactParticipant,
  requireAccountablePeer,
  requireNoEngagedPactWithPeer,
  requirePactParticipant,
  requireSensitiveMembership,
  requireThread,
  requireThreadParticipant,
  requireUnclaimedPact,
  type PactActorContext
} from './pact-shared'
import { OrchestrationError } from './orchestration-error'

export type ProposePactParams = PactActorContext & {
  threadId: string
  peerAgentId: string
  stepsTotal: number | null // null = --open
}

export function proposePact(db: Database.Database, params: ProposePactParams): ThreadRow {
  const thread = requireThread(db, params.threadId)
  requireThreadParticipant(db, thread.id, params.callerAgentId)
  const peer = requireAccountablePeer(db, params.peerAgentId)
  requireSensitiveMembership(db, thread, peer.id, peer.display_name)
  requireUnclaimedPact(thread)
  requireNoEngagedPactWithPeer(db, params.callerAgentId, peer.id, peer.display_name)

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE threads SET
         pact_proposer_agent_id = ?, pact_with_agent_id = ?, pact_state = 'proposed',
         pact_steps_total = ?, pact_ordinal = 0, pact_turn_agent_id = NULL,
         pact_paused_at = NULL, pact_pause_reason = NULL, pact_at = datetime('now')
       WHERE id = ?`
    ).run(params.callerAgentId, peer.id, params.stepsTotal, thread.id)
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: 0,
      kind: 'propose',
      actorAgentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      messageId: null,
      summary: null,
      turnAfterAgentId: null,
      reasonCode: null
    })
    auditPact(db, {
      agentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      verb: 'pact_propose',
      outcome: 'proposed'
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return requireThread(db, thread.id)
}

export type AcceptPactParams = PactActorContext & { threadId: string }

// Turn moves to the proposer first (RPCS §).
export function acceptPact(db: Database.Database, params: AcceptPactParams): ThreadRow {
  const thread = requireThread(db, params.threadId)
  requireProposedTo(thread, params.callerAgentId)

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?, pact_at = datetime('now')
       WHERE id = ?`
    ).run(thread.pact_proposer_agent_id, thread.id)
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: 0,
      kind: 'accept',
      actorAgentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      messageId: null,
      summary: null,
      turnAfterAgentId: thread.pact_proposer_agent_id,
      reasonCode: null
    })
    auditPact(db, {
      agentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      verb: 'pact_accept',
      outcome: 'engaged'
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return requireThread(db, thread.id)
}

export type DeclinePactParams = PactActorContext & { threadId: string; reasonCode: string | null }

export function declinePact(db: Database.Database, params: DeclinePactParams): ThreadRow {
  const thread = requireThread(db, params.threadId)
  requireProposedTo(thread, params.callerAgentId)
  return releasePactRow(db, thread, params, 'decline')
}

// Authority: pact_with_agent_id only, and only while still 'proposed' (accept/decline answer
// the SAME proposal; a re-decline after accept goes through releasePact instead).
function requireProposedTo(thread: ThreadRow, callerAgentId: string): void {
  if (thread.pact_state !== 'proposed' || thread.pact_with_agent_id !== callerAgentId) {
    throw new OrchestrationError(
      'not_a_participant',
      `Refused: there is no pending pact proposal to you on ${thread.id}.`,
      { nextSteps: [`orca agents pact --show ${thread.id}`] }
    )
  }
}

// Shared by declinePact and releasePact (pact-lifecycle.ts) — both move pact_state to
// 'released' and clear the turn; the only difference is the ledger kind / audit verb.
export function releasePactRow(
  db: Database.Database,
  thread: ThreadRow,
  params: PactActorContext & { reasonCode: string | null },
  kind: 'decline' | 'release'
): ThreadRow {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE threads SET pact_state = 'released', pact_turn_agent_id = NULL,
         pact_paused_at = NULL, pact_pause_reason = NULL, pact_at = datetime('now')
       WHERE id = ?`
    ).run(thread.id)
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: 0,
      kind,
      actorAgentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      messageId: null,
      summary: null,
      turnAfterAgentId: null,
      reasonCode: params.reasonCode
    })
    auditPact(db, {
      agentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      verb: `pact_${kind}`,
      outcome: 'released',
      reasonCode: params.reasonCode
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return requireThread(db, thread.id)
}

// Re-exported for pact-lifecycle.ts's releasePact (K11: either participant, any state).
export { requirePactParticipant, otherPactParticipant }
