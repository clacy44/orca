// S10-3 pact spec — pause/resume/release, and the liveness auto-pause hooks (K6/K16/K17).
// Split out of pact-propose-accept.ts per the max-lines ratchet.
import type Database from '../../sqlite/sync-database'
import type { ThreadRow } from './types'
import type { PactPauseReason } from './pact-types'
import { OrchestrationError } from './orchestration-error'
import {
  auditPact,
  insertPactStepRow,
  requireEngaged,
  requirePactParticipant,
  requireThread,
  type PactActorContext
} from './pact-shared'
import { releasePactRow } from './pact-propose-accept'

export type PausePactParams = PactActorContext & { threadId: string; reasonCode: string | null }

export function pausePact(db: Database.Database, params: PausePactParams): ThreadRow {
  const thread = requireThread(db, params.threadId)
  requirePactParticipant(thread, params.callerAgentId)
  requireEngaged(thread)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE threads SET pact_paused_at = datetime('now'), pact_pause_reason = ? WHERE id = ?`
    ).run(params.reasonCode ?? 'operator', thread.id)
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: 0,
      kind: 'pause',
      actorAgentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      messageId: null,
      summary: null,
      turnAfterAgentId: null,
      reasonCode: params.reasonCode ?? 'operator'
    })
    auditPact(db, {
      agentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      verb: 'pact_pause',
      outcome: 'paused',
      reasonCode: params.reasonCode ?? 'operator'
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return requireThread(db, thread.id)
}

function latestPausingAgentId(db: Database.Database, threadId: string): string | null {
  const row = db
    .prepare(
      `SELECT actor_agent_id FROM pact_steps WHERE thread_id = ? AND kind = 'pause' ORDER BY seq DESC LIMIT 1`
    )
    .get(threadId) as { actor_agent_id: string | null } | undefined
  return row?.actor_agent_id ?? null
}

// Rev 5: thread-level pauses (thread_closed/thread_paused) have no reopen verb — resume is
// refused forever and the only printed next step is release.
const NEVER_RESUMABLE_REASONS: ReadonlySet<PactPauseReason> = new Set([
  'thread_closed',
  'thread_paused'
])

export type ResumePactParams = PactActorContext & { threadId: string }
export type ResumePactOutcome =
  | { kind: 'resumed'; thread: ThreadRow }
  | { kind: 'requested'; thread: ThreadRow; pausingAgentId: string }

// Dispatcher behind the CLI's single `pact --resume` flag (AUTHORITY §): the pausing side
// resumes unilaterally; a resume_request from anyone else records intent only and leaves the
// pact paused (K16) — the pausing side's own later `--resume` call always succeeds regardless.
export function resumePactOrRequest(
  db: Database.Database,
  params: ResumePactParams
): ResumePactOutcome {
  const thread = requireThread(db, params.threadId)
  requirePactParticipant(thread, params.callerAgentId)
  if (thread.pact_paused_at === null) {
    throw new OrchestrationError('pact_not_paused', `Refused: ${thread.id}'s pact is not paused.`, {
      nextSteps: [`orca agents pact --show ${thread.id}`]
    })
  }
  if (
    thread.pact_pause_reason &&
    NEVER_RESUMABLE_REASONS.has(thread.pact_pause_reason as PactPauseReason)
  ) {
    throw new OrchestrationError(
      'pact_paused',
      `Refused: this pact is paused (${thread.pact_pause_reason}) and the thread has no reopen verb. ` +
        `Release it: orca agents pact --release --on ${thread.id}.`,
      { nextSteps: [`orca agents pact --release --on ${thread.id}`] }
    )
  }
  const pausingAgentId = latestPausingAgentId(db, thread.id)
  if (pausingAgentId !== null && pausingAgentId !== params.callerAgentId) {
    const updated = requestPactResume(db, params)
    return { kind: 'requested', thread: updated, pausingAgentId }
  }
  return { kind: 'resumed', thread: resumePact(db, params) }
}

export function requestPactResume(db: Database.Database, params: ResumePactParams): ThreadRow {
  const thread = requireThread(db, params.threadId)
  db.exec('BEGIN IMMEDIATE')
  try {
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: 0,
      kind: 'resume_request',
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
      verb: 'pact_resume_request',
      outcome: 'requested'
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return requireThread(db, thread.id)
}

// Clears the pause; the turn is left exactly where it was (pause never moved it, rev 4).
export function resumePact(db: Database.Database, params: ResumePactParams): ThreadRow {
  const thread = requireThread(db, params.threadId)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE threads SET pact_paused_at = NULL, pact_pause_reason = NULL WHERE id = ?`
    ).run(thread.id)
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: 0,
      kind: 'resume',
      actorAgentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      messageId: null,
      summary: null,
      turnAfterAgentId: thread.pact_turn_agent_id,
      reasonCode: null
    })
    auditPact(db, {
      agentId: params.callerAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.callerHostId,
      verb: 'pact_resume',
      outcome: 'resumed'
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return requireThread(db, thread.id)
}

export type ReleasePactParams = PactActorContext & { threadId: string; reasonCode: string | null }

// Always unilateral, always available to either participant, any state including paused (K11)
// — the escape hatch of last resort is never gated on the counterpart.
export function releasePact(db: Database.Database, params: ReleasePactParams): ThreadRow {
  const thread = requireThread(db, params.threadId)
  if (thread.pact_state === null || thread.pact_state === 'released') {
    throw new OrchestrationError(
      'pact_not_engaged',
      `Refused: ${thread.id} has no active pact to release.`,
      { nextSteps: [`orca agents pact --show ${thread.id}`] }
    )
  }
  requirePactParticipant(thread, params.callerAgentId)
  return releasePactRow(db, thread, params, 'release')
}

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
  reason: PactPauseReason
): AutoPauseOutcome {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE threads SET pact_paused_at = datetime('now'), pact_pause_reason = ? WHERE id = ?`
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
  reason: PactPauseReason
): AutoPauseOutcome[] {
  const rows = db
    .prepare(
      `SELECT * FROM threads WHERE purged_at IS NULL AND pact_state = 'engaged'
       AND pact_paused_at IS NULL AND (pact_proposer_agent_id = ? OR pact_with_agent_id = ?)`
    )
    .all(agentId, agentId) as ThreadRow[]
  return rows.map((thread) => autoPauseOneThread(db, thread, reason))
}

// K17 (thread_closed/thread_paused): a single thread's engaged pact, regardless of which side
// triggered the thread-state change.
export function autoPausePactOnThread(
  db: Database.Database,
  threadId: string,
  reason: PactPauseReason
): AutoPauseOutcome | null {
  const thread = db
    .prepare(`SELECT * FROM threads WHERE id = ? AND purged_at IS NULL`)
    .get(threadId) as ThreadRow | undefined
  if (!thread || thread.pact_state !== 'engaged' || thread.pact_paused_at !== null) {
    return null
  }
  return autoPauseOneThread(db, thread, reason)
}
