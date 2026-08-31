// S10-3 pact spec — orchestration.threads.step's db-level writer (RPCS §, ruling 5 / A5): the
// ONE caller of insertGatedMessage's hostPayloadKind, so only this path can ever mint a
// payload_kind='pact_step' row (K25). Split out per the max-lines ratchet.
import type Database from '../../sqlite/sync-database'
import type { GateVerdict } from '../../../shared/message-body-gate'
import { sanitizeMessageText } from '../../../shared/message-text'
import { insertGatedMessage, type InsertGatedMessageParams } from './message-gate-writer'
import { bumpThreadOnMessage } from './thread-directory'
import { OrchestrationError } from './orchestration-error'
import type { MessageRow, ThreadRow } from './types'
import {
  auditPact,
  insertPactStepRow,
  otherPactParticipant,
  pactWaiterHandle,
  requireEngaged,
  requirePactParticipant,
  requirePaused,
  requireThread,
  type PactActorContext
} from './pact-shared'

const PACT_STEP_SUMMARY_MAX_LENGTH = 120

type GateOptions = Pick<
  InsertGatedMessageParams,
  'senderPaneKey' | 'acknowledgeGate' | 'infraAllowlist'
>

export type AppendPactStepParams = PactActorContext &
  GateOptions & {
    threadId: string
    done: string
    /** PEER_RUN_ID (db.ts) — injected by the caller to avoid a require cycle (peer-question.ts
     * precedent). */
    runId: string
  }

export type AppendPactStepResult =
  | {
      outcome: 'stepped'
      thread: ThreadRow
      ordinal: number
      of: number | null
      turn: string
      message: MessageRow
      gateFlags: string[] | null
    }
  | { outcome: 'refused'; verdict: Extract<GateVerdict, { tier: 'hard' }>; refusalId: number }

// Refused not_your_turn (K1) / pact_paused (K16, F4) BEFORE the gate ever runs — an off-turn or
// paused caller's text is never even evaluated, let alone stored (containment's "same choke, no
// side door" is about the store path, not an excuse to gate text nobody was allowed to send).
export function appendPactStep(
  db: Database.Database,
  params: AppendPactStepParams
): AppendPactStepResult {
  const thread = requireThread(db, params.threadId)
  requirePactParticipant(thread, params.callerAgentId)
  requireEngaged(thread)
  requirePaused(thread)
  if (thread.pact_turn_agent_id !== params.callerAgentId) {
    throw new OrchestrationError(
      'not_your_turn',
      `Refused: it is not your turn on ${thread.id} (waiting on ${thread.pact_turn_agent_id}).`,
      { nextSteps: [`orca agents wait --thread ${thread.id} --for step`] }
    )
  }
  const other = otherPactParticipant(thread, params.callerAgentId)

  // K3: a HARD-gated --done stores no message, appends no ledger row, leaves the turn where it
  // was — insertGatedMessage's own refusal path writes its gate_refusals audit row (GATE §) and
  // returns rather than throwing; nothing below this point has run yet, so there's nothing to
  // roll back (same precedent as peer-question.ts's createPeerQuestion).
  const inserted = insertGatedMessage(db, {
    from: pactWaiterHandle(params.callerAgentId),
    to: pactWaiterHandle(other),
    subject: 'pact step',
    body: params.done,
    type: 'status',
    threadId: thread.id,
    hostPayloadKind: 'pact_step',
    runId: params.runId,
    senderPaneKey: params.senderPaneKey ?? params.callerPaneKey,
    senderHostId: params.callerHostId,
    acknowledgeGate: params.acknowledgeGate,
    infraAllowlist: params.infraAllowlist,
    verb: 'step'
  })
  if (inserted.outcome === 'refused') {
    return { outcome: 'refused', verdict: inserted.verdict, refusalId: inserted.refusalId }
  }

  const nextOrdinal = thread.pact_ordinal + 1
  const summary = sanitizeMessageText(params.done, PACT_STEP_SUMMARY_MAX_LENGTH).value

  // P1: the ledger append and the turn flip commit atomically in one BEGIN IMMEDIATE — K2's
  // partial unique index (idx_pact_step_ordinal) is the backstop, not the primary guarantee.
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE threads SET pact_ordinal = ?, pact_turn_agent_id = ? WHERE id = ?`).run(
      nextOrdinal,
      other,
      thread.id
    )
    bumpThreadOnMessage(db, thread.id, inserted.message)
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: nextOrdinal,
      kind: 'step',
      actorAgentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      messageId: inserted.message.id,
      summary,
      turnAfterAgentId: other,
      reasonCode: null
    })
    auditPact(db, {
      agentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      verb: 'pact_step',
      outcome: 'stepped'
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  const updated = requireThread(db, thread.id)
  return {
    outcome: 'stepped',
    thread: updated,
    ordinal: nextOrdinal,
    of: updated.pact_steps_total,
    turn: other,
    message: inserted.message,
    gateFlags: inserted.message.gate_flags
      ? (JSON.parse(inserted.message.gate_flags) as string[])
      : null
  }
}
