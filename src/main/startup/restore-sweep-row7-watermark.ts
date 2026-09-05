// S10-21a C7j (Ruling 34 Addendum 27, row 7): the sweep-body/per-candidate row-7 glue, split out
// of restore-registered-agent-panes.ts to stay under the max-lines ratchet.
import type { AgentLaunchSessionRow } from '../runtime/orchestration/agent-launch-sessions'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { decideRow7 } from '../runtime/orchestration/restore-sweep-decision'
import { paneSuffix } from '../runtime/orchestration/agent-restore-rebind-predicate'
import { auditSweepSkip } from '../runtime/orchestration/restore-sweep-audit'

/** The sweep's ONE "watermark not captured" note — called once by `runRestoreSweepBody` when
 * `deps.getSelfResumeWatermark()` came back null, never per-candidate (no single candidate
 * pane "caused" the absence). */
export function noteSelfResumeWatermarkAbsent(db: OrchestrationDb, hostId: string): void {
  db.writeAgentAudit({
    agentId: null,
    actorPaneKey: null,
    actorHostId: hostId,
    verb: 'sweep_note',
    outcome: 'proceeded',
    reasonCode: 'self_resume_signal_unavailable: watermark_not_captured'
  })
}

/** Row 7 for one candidate. Evaluated after rows 5-6 and before rows 8-11 — see
 * restore-sweep-decision.ts's `decideRow7`. Returns `'skipped_leaf_held'` (already audited) when
 * row 7 fires; `null` when it does not fire, OR when `selfResumeWatermark` is itself absent (row
 * 7 is then skipped entirely for this sweep — `noteSelfResumeWatermarkAbsent` above is the
 * caller's own once-per-sweep record of that, not this function's). */
export function evaluateRow7(
  db: OrchestrationDb,
  hostId: string,
  agentId: string,
  launchRow: AgentLaunchSessionRow,
  selfResumeWatermark: number | null
): 'skipped_leaf_held' | null {
  if (selfResumeWatermark === null) {
    return null
  }
  const hit = db.newestSelfResumeAuditForPane(
    hostId,
    paneSuffix(launchRow.pane_key),
    selfResumeWatermark
  )
  const row7 = decideRow7(hit)
  if (row7.kind === 'skipped_leaf_held') {
    auditSweepSkip(db, hostId, launchRow.pane_key, agentId, row7.reasonCode)
    return 'skipped_leaf_held'
  }
  return null
}
