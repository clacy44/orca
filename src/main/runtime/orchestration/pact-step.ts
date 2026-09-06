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
  requireCallerNotQuarantined,
  requireEngaged,
  requirePactParticipant,
  requirePaused,
  requireThread,
  type PactActorContext
} from './pact-shared'
import { isFederatedPact } from './pact-federated-identity'
import { enqueueFederatedPactVerb, type FederatedPactEmitRuntime } from './pact-federated-emit'

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
    // S10-21b B6 (design §2.3): only consulted for a federated pact (`isFederatedPact(thread)`)
    // — never touches a local pact's step path. Optional/omittable so every existing local-pact
    // caller (and every pre-existing test) is unaffected; a federated step called with no
    // runtime simply skips the post-commit outbox kick (the pump's own idle-wake still drains
    // it eventually — see the OPEN note in the commit body).
    runtime?: FederatedPactEmitRuntime | null
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

// Refused not_your_turn (K1) / pact_paused (K16, F4) / agent_quarantined (AUTHORITY §) BEFORE
// the gate ever runs — an off-turn, paused or quarantined caller's text is never even evaluated,
// let alone stored (containment's "same choke, no side door" is about the store path, not an
// excuse to gate text nobody was allowed to send).
export function appendPactStep(
  db: Database.Database,
  params: AppendPactStepParams
): AppendPactStepResult {
  const thread = requireThread(db, params.threadId)
  requirePactParticipant(thread, params.callerAgentId)
  requireEngaged(thread)
  requirePaused(thread)
  requireCallerNotQuarantined(db, params.callerAgentId, thread.id)
  if (thread.pact_turn_agent_id !== params.callerAgentId) {
    throw new OrchestrationError(
      'not_your_turn',
      `Refused: it is not your turn on ${thread.id} (waiting on ${thread.pact_turn_agent_id}).`,
      { nextSteps: [`orca agents wait --thread ${thread.id} --for step`] }
    )
  }
  const other = otherPactParticipant(thread, params.callerAgentId)
  const nextOrdinal = thread.pact_ordinal + 1
  const summary = sanitizeMessageText(params.done, PACT_STEP_SUMMARY_MAX_LENGTH).value

  // S10-21b B6 (design §2.3, T3): a federated pact's step is the DEFERRED turn flip — the
  // ledger/ordinal advance immediately (this host's own progress), but pact_turn_agent_id does
  // NOT move here; that is commit 7's settle job. Delegates the whole write to the shared emit
  // primitive rather than duplicating §2.3's six steps here.
  if (isFederatedPact(thread)) {
    const emitted = enqueueFederatedPactVerb(db, params.runtime ?? null, thread.id, 'step', {
      actorAgentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      runId: params.runId,
      senderPaneKey: params.senderPaneKey ?? params.callerPaneKey,
      bodyText: params.done,
      subject: 'pact step',
      acknowledgeGate: params.acknowledgeGate,
      infraAllowlist: params.infraAllowlist,
      ordinal: nextOrdinal,
      wireOrdinal: nextOrdinal,
      turnAfterAgentId: other,
      summary
    })
    if (emitted.outcome === 'refused') {
      return { outcome: 'refused', verdict: emitted.verdict, refusalId: emitted.refusalId }
    }
    const gateFlags = emitted.message.gate_flags
      ? (JSON.parse(emitted.message.gate_flags) as string[])
      : null
    return {
      outcome: 'stepped',
      thread: emitted.thread,
      ordinal: nextOrdinal,
      of: emitted.thread.pact_steps_total,
      // The turn stays with the CALLER until settle (§2.2's in-flight interval) — never `other`.
      turn: params.callerAgentId,
      message: emitted.message,
      gateFlags
    }
  }

  // P1 (blocker fix, S10-3b review): the gated message insert, the ledger append and the turn
  // flip commit atomically in ONE BEGIN IMMEDIATE, per spec RPCS § ("One transaction:
  // insertGatedMessage -> pact_steps append -> UPDATE threads"). The prior split — the message
  // insert committed on its own before this transaction opened — let a step that failed here
  // (idx_pact_step_ordinal, or any other mid-transaction error) leave an orphaned, already-
  // committed pact_step message with no ledger row and no turn flip: a step the counterpart's
  // pane and `wait --for step` could observe that the ledger, the third-party check this whole
  // spec exists for, never recorded. K3's HARD-gate refusal is still not a rollback case —
  // insertGatedMessage returns 'refused' as a normal value (its own gate_refusals row is the
  // audit trail) rather than throwing, so that branch below still commits just that row and
  // returns, never touching the ledger or the turn.
  db.exec('BEGIN IMMEDIATE')
  try {
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
      // K3: no message, no ledger row, no turn flip — only the gate_refusals audit row inserted
      // above. Commit it (it must survive) and stop; nothing else in this transaction was written.
      db.exec('COMMIT')
      return { outcome: 'refused', verdict: inserted.verdict, refusalId: inserted.refusalId }
    }

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
    // Read-backs run INSIDE the transaction: anything throwing after COMMIT but before this
    // try's catch would issue a second ROLLBACK on a closed transaction and mask the real
    // error with ERR_SQLITE_ERROR (the S10-1 ack / relay-import lesson).
    const updated = requireThread(db, thread.id)
    const gateFlags = inserted.message.gate_flags
      ? (JSON.parse(inserted.message.gate_flags) as string[])
      : null
    db.exec('COMMIT')
    return {
      outcome: 'stepped',
      thread: updated,
      ordinal: nextOrdinal,
      of: updated.pact_steps_total,
      turn: other,
      message: inserted.message,
      gateFlags
    }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
