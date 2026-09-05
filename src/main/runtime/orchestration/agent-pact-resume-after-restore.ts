// S10-21a C10 (design v3.2 §2.11 N4 fix, drill criterion 8; Ruling 34 Addendum 25): the pact
// un-pause half of the counterpart_gone auto-pause. Host-authored, symmetric to
// `autoPausePactsForAgent`'s own host-row pause (pact-lifecycle.ts): no `callerAgentId` of its
// own. `resumePact`/`resumePactOrRequest` (pact-lifecycle.ts) both require a real participant
// caller and throw for a non-participant — pty.ts's own comment at its C10 call site names this
// exact reason a separate primitive is needed rather than calling either of those.
//
// Called POST-COMMIT by both consumers named in Addendum 25, each passing its own
// `pactsToUnpause` result field:
//   - the sweep (restore-registered-agent-panes.ts) after `rebindRestoredPane` returns
//     `{ ok: true, rebound: true }`
//   - pty.ts's daemon-respawn gate after `refreshAgentHandleAfterRespawn` returns `{ ok: true }`
//
// Each pact gets its OWN `BEGIN IMMEDIATE...COMMIT` (never the caller's transaction — matches
// `resumePact`'s own convention), so one pact's failure cannot roll back another's resume or the
// rebind that already committed before this was ever called (§2.11: "a pact that cannot resume
// does not undo a rebind"). A failure is caught per-pact, logged, and audited — never thrown
// into the caller.
import type Database from '../../sqlite/sync-database'
import type { ThreadRow } from './types'
import { insertPactStepRow, auditPact } from './pact-shared'

/** Resumes every listed pact still eligible: `pact_state = 'engaged'`, `pact_paused_at IS NOT
 * NULL`, `pact_pause_reason = 'counterpart_gone'`, and `agentId` a participant (the restored
 * agent whose liveness transition caused the auto-pause). Re-checked inside each pact's own
 * transaction rather than trusted from the caller's (possibly stale-by-now) list — a pact
 * already resumed, paused for a different reason, or paused over a different agent's absence is
 * silently left untouched (not an error; no audit row for a non-eligible pact). Never throws. */
export function resumePactsForRestoredAgent(
  db: Database.Database,
  agentId: string,
  pactIds: string[]
): void {
  for (const threadId of pactIds) {
    try {
      resumeOnePactIfEligible(db, agentId, threadId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // [§2.11: "a pact that cannot resume does not undo a rebind"] Logged + audited, never
      // rethrown — matches restore-registered-agent-panes.ts's own delivery_notify_failed
      // convention (a post-commit follow-up's failure is a note, not a sweep failure).
      console.warn('[orchestration] pact resume after rebind failed', {
        threadId,
        agentId,
        message
      })
      auditPact(db, {
        agentId,
        actorPaneKey: null,
        actorHostId: null,
        verb: 'pact_resumed_after_rebind',
        outcome: 'failed',
        reasonCode: `resume_after_rebind_failed: ${message}`
      })
    }
  }
}

function resumeOnePactIfEligible(db: Database.Database, agentId: string, threadId: string): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const thread = db
      .prepare(`SELECT * FROM threads WHERE id = ? AND purged_at IS NULL`)
      .get(threadId) as ThreadRow | undefined
    const eligible =
      thread !== undefined &&
      thread.pact_state === 'engaged' &&
      thread.pact_paused_at !== null &&
      thread.pact_pause_reason === 'counterpart_gone' &&
      (thread.pact_proposer_agent_id === agentId || thread.pact_with_agent_id === agentId)
    if (!eligible || !thread) {
      db.exec('COMMIT')
      return
    }
    db.prepare(
      `UPDATE threads SET pact_paused_at = NULL, pact_pause_reason = NULL WHERE id = ?`
    ).run(thread.id)
    insertPactStepRow(db, {
      threadId: thread.id,
      ordinal: 0,
      kind: 'resume',
      actorAgentId: null,
      actorPaneKey: null,
      actorHostId: null,
      messageId: null,
      summary: null,
      turnAfterAgentId: thread.pact_turn_agent_id,
      reasonCode: 'counterpart_gone'
    })
    auditPact(db, {
      agentId,
      actorPaneKey: null,
      actorHostId: null,
      verb: 'pact_resumed_after_rebind',
      outcome: 'resumed',
      reasonCode: 'counterpart_gone'
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
