// S10-21c (chore, 2026-09-08): resume-preflight arm split out of
// restore-registered-agent-panes.ts to stay under the max-lines ratchet. Pure move — same
// `decideResumePreflight`/`notifyPaneBestEffort`/audit calls, same control flow (an 'uncovered'
// decision notes and continues; 'refuse' audits, notifies best-effort, and returns the Layer-3
// outcome; the covered/no-refusal case returns null so the caller proceeds to mint the ticket).
import type { AgentLaunchSessionRow } from '../runtime/orchestration/agent-launch-sessions'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { decideResumePreflight } from '../runtime/orchestration/restore-sweep-decision'
import { auditLayer3, auditSweepNote } from '../runtime/orchestration/restore-sweep-audit'
import { notifyPaneBestEffort } from './restore-sweep-pane-notice'
import type { RestoreSweepDeps, RestoreOneOutcome } from './restore-sweep-types'

/** [S10-21c B2, design §2 S4] Resume preflight — never resume an empty transcript, before any
 * ticket is minted. A resolver throw is NOT caught here — it propagates to the sweep's own
 * per-candidate try/catch, downgraded to a Layer-3 audit for this pane only. Returns the
 * Layer-3 outcome to short-circuit on a refusal, or null when the caller should proceed. */
export async function applyResumePreflight(
  deps: RestoreSweepDeps,
  db: OrchestrationDb,
  hostId: string,
  launchRow: AgentLaunchSessionRow,
  agentId: string
): Promise<RestoreOneOutcome | null> {
  const transcript = await deps.resolveResumeTranscript(launchRow.agent_type, launchRow.session_id)
  const preflight = decideResumePreflight(transcript, launchRow.agent_type, launchRow.session_id)
  if (preflight.kind === 'uncovered') {
    auditSweepNote(db, hostId, launchRow.pane_key, agentId, preflight.reasonCode)
  } else if (preflight.kind === 'refuse') {
    auditLayer3(db, hostId, launchRow.pane_key, agentId, preflight.reasonCode)
    // [D-R145 medium 6a, D-R148 low 7] Best-effort — inert on a pane with nothing live, per
    // writeHostNoticeToPane's own doc comment; the audit row above is the record of truth. A
    // throw here degrades to a `notice_failed:` note (never aborts this outcome) — asserted in
    // the S4 test so neither behaviour can rot.
    const msg = 'Restore skipped: the recorded session has no conversation to resume.'
    notifyPaneBestEffort(
      deps,
      db,
      hostId,
      launchRow.pane_key,
      agentId,
      msg,
      'sweep_resume_target_absent'
    )
    return { kind: 'layer3', reasonCode: preflight.reasonCode }
  }
  return null
}
