// S10-3 pact spec — pause/resume/release, and the liveness auto-pause hooks (K6/K16/K17).
// Split out of pact-propose-accept.ts per the max-lines ratchet.
import type Database from '../../sqlite/sync-database'
import type { ThreadRow } from './types'
import type { PactPauseReason } from './pact-types'
import { OrchestrationError } from './orchestration-error'
import { sanitizeMessageText } from '../../../shared/message-text'
import {
  auditPact,
  insertPactStepRow,
  requireEngaged,
  requirePactParticipant,
  requireThread,
  type PactActorContext
} from './pact-shared'
import { releasePactRow } from './pact-propose-accept'
import { isFederatedPact } from './pact-federated-identity'
import type { SupersessionChainWalker } from './pact-federated-rebind'
import {
  remoteMirrorQuarantined,
  latestHostPauseReasonCode,
  latestPausingAgentId
} from './pact-federated-pause-remote-arm'
import {
  emitFederatedPactSideEffect,
  type FederatedPactEmitRuntime
} from './pact-federated-pause-resume-emit'

// S10-21b B12b (design §5, "`--evidence '<run id / suite citation>'`" — no length named; VERIFY
// in b12-brief.md found no prior evidence-handling pattern for a pact release, so this reuses
// pact-step.ts's own step-summary sanitizer/cap shape rather than inventing a second one).
const PACT_RELEASE_EVIDENCE_MAX_LENGTH = 500

export type PausePactParams = PactActorContext & {
  threadId: string
  reasonCode: string | null
  // S10-21b B15 (design §2.7, ruling 21b-E7): a federated pact's pause routes THROUGH
  // emitFederatedPactSideEffect (the single atomic writer) instead of the local UPDATE below.
  runtime?: FederatedPactEmitRuntime | null
}

export function pausePact(db: Database.Database, params: PausePactParams): ThreadRow {
  const thread = requireThread(db, params.threadId)
  requirePactParticipant(thread, params.callerAgentId)
  requireEngaged(thread)
  if (isFederatedPact(thread)) {
    emitFederatedPactSideEffect(
      db,
      params.runtime ?? null,
      thread.id,
      'pause',
      params.reasonCode ?? 'operator',
      {
        agentId: params.callerAgentId,
        paneKey: params.callerPaneKey,
        hostId: params.callerHostId
      }
    )
    return requireThread(db, thread.id)
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    // D-R134 F4 local half: pact_flight_token bumped alongside the pause it guards.
    db.prepare(
      `UPDATE threads SET pact_paused_at = datetime('now'), pact_pause_reason = ?,
         pact_flight_token = pact_flight_token + 1 WHERE id = ?`
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

// Major fix (S10-3b review): AUTHORITY § — "either participant [may resume] when the pause row
// is a host row (actor_agent_id IS NULL) AND its condition has cleared." Only host-row reasons
// (autoPauseOneThread's three liveness reasons; thread_closed/thread_paused are refused earlier
// as NEVER_RESUMABLE) reach this check. Checked against BOTH participants, not just the one who
// triggered the pause — the host row never records which side that was, and requiring the whole
// pair to be clear is what stops the quarantined/gone/left side from lifting its own pause: if
// it is still quarantined/gone/left, the condition has not cleared, no matter who calls resume.
// S10-21b B14 (design §4.4, D-R135 F17) gains the federated remote arms below: a rendered
// `remote:<link>:<id>` key never matched `agents.id`, so both predicates read CLEARED before.
function pauseConditionCleared(
  db: Database.Database,
  thread: ThreadRow,
  walkSupersessionChain: SupersessionChainWalker
): boolean {
  const proposer = thread.pact_proposer_agent_id
  const withAgent = thread.pact_with_agent_id
  if (!proposer || !withAgent) {
    return false
  }
  const reason = thread.pact_pause_reason
  if (reason === 'counterpart_quarantined') {
    const row = db
      .prepare(
        `SELECT 1 FROM agents WHERE id IN (?, ?) AND quarantined = 1 AND tombstoned_at IS NULL`
      )
      .get(proposer, withAgent)
    if (row) {
      return false
    }
    // Remote arm (design §4.4 row 1, split to pact-federated-pause-remote-arm.ts): a
    // counterpart_quarantined pause on a federated pact is not resumable while the mirror
    // (walked through B2's supersession chain) is quarantined.
    if (isFederatedPact(thread) && remoteMirrorQuarantined(db, thread, walkSupersessionChain)) {
      return false
    }
    return true
  }
  if (reason === 'counterpart_gone') {
    // Errata NB1: both share pact_pause_reason='counterpart_gone' (no CHECK widened) — only the
    // ledger row's own reason_code disambiguates. 'counterpart_unreachable' is NEVER cleared
    // here; only commit 15's link-recovery sweep clears it (refuses manual --resume meanwhile).
    const ledgerReasonCode = latestHostPauseReasonCode(db, thread.id)
    if (ledgerReasonCode === 'counterpart_unreachable') {
      return false
    }
    const row = db
      .prepare(`SELECT 1 FROM agents WHERE id IN (?, ?) AND state = 'gone'`)
      .get(proposer, withAgent)
    return !row
  }
  if (reason === 'counterpart_left') {
    const activeCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM thread_participants
         WHERE thread_id = ? AND participant_key IN (?, ?) AND left_at IS NULL`
      )
      .get(thread.id, proposer, withAgent) as { n: number }
    return activeCount.n === 2
  }
  // thread_closed/thread_paused never reach here (refused earlier); an unexpected/'operator'/null
  // reason on a host row has no clearable condition to check — never auto-resumable.
  return false
}

// D-R134 F13 fix (filters actor_is_remote = 0) now lives in pact-federated-pause-remote-arm.ts,
// split out per the max-lines ratchet.

// Rev 5: thread-level pauses (thread_closed/thread_paused) have no reopen verb — resume is
// refused forever and the only printed next step is release.
const NEVER_RESUMABLE_REASONS: ReadonlySet<PactPauseReason> = new Set([
  'thread_closed',
  'thread_paused'
])

export type ResumePactParams = PactActorContext & {
  threadId: string
  // S10-21b B15 (design §2.7, ruling 21b-E7): see PausePactParams.runtime.
  runtime?: FederatedPactEmitRuntime | null
}
export type ResumePactOutcome =
  | { kind: 'resumed'; thread: ThreadRow }
  | { kind: 'requested'; thread: ThreadRow; pausingAgentId: string }

// Dispatcher behind the CLI's single `pact --resume` flag (AUTHORITY §): the pausing side
// resumes unilaterally; a resume_request from anyone else records intent only and leaves the
// pact paused (K16) — the pausing side's own later `--resume` call always succeeds regardless.
export function resumePactOrRequest(
  db: Database.Database,
  params: ResumePactParams,
  walkSupersessionChain: SupersessionChainWalker
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
  // Major fix (S10-3b review): pausingAgentId === null is a HOST row (auto-pause), not "anyone
  // may resume unconditionally" — AUTHORITY § grants either participant that authority only
  // once the pause's own condition has cleared. Without this check a quarantined/gone/left
  // participant lifts its own containment auto-pause and keeps driving the pact.
  if (pausingAgentId === null && !pauseConditionCleared(db, thread, walkSupersessionChain)) {
    throw new OrchestrationError(
      'pact_paused',
      `Refused: this pact is paused (${thread.pact_pause_reason}) and the condition has not ` +
        `cleared yet. Release it: orca agents pact --release --on ${thread.id}.`,
      { nextSteps: [`orca agents pact --release --on ${thread.id}`] }
    )
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
  if (isFederatedPact(thread)) {
    emitFederatedPactSideEffect(db, params.runtime ?? null, thread.id, 'resume', null, {
      agentId: params.callerAgentId,
      paneKey: params.callerPaneKey,
      hostId: params.callerHostId
    })
    return requireThread(db, thread.id)
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    // D-R134 F4 local half: pact_flight_token bumped alongside the resume it guards.
    db.prepare(
      `UPDATE threads SET pact_paused_at = NULL, pact_pause_reason = NULL,
         pact_flight_token = pact_flight_token + 1 WHERE id = ?`
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

export type ReleasePactParams = PactActorContext & {
  threadId: string
  reasonCode: string | null
  // S10-21b B12b (design §5, SCOPE item 2): "<run id / suite citation>" — decline never carries
  // one (releasePactRow's other caller passes summary: null explicitly).
  evidence?: string | null
  // S10-21b B6c: see ProposePactParams.runtime (pact-propose-accept.ts).
  runtime?: FederatedPactEmitRuntime | null
}

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
  const summary = params.evidence
    ? sanitizeMessageText(params.evidence, PACT_RELEASE_EVIDENCE_MAX_LENGTH).value
    : null
  return releasePactRow(db, thread, { ...params, summary }, 'release')
}

// K6/K16/K17 liveness auto-pause hooks now live in pact-lifecycle-autopause.ts (split out per
// the max-lines ratchet) — re-exported here so every existing importer of pact-lifecycle.ts
// (db.ts) is untouched. R3 (D-R136) flight-token bump carried into the moved
// autoPauseOneThread (pact-lifecycle-autopause.ts) so both intents survive.
export {
  autoPausePactsForAgent,
  autoPausePactOnThread,
  type AutoPauseOutcome
} from './pact-lifecycle-autopause'
