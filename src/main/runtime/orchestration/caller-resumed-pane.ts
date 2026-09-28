// Artifact 10z.5 R290 (T18): true when a pane was caller-resumed into a session whose registered
// identity is bound to ANOTHER pane. Such a pane already has an owner elsewhere, so the register
// nudge ("an identity waits on this worktree") is wrong for it. Durable evidence only: the pane's
// own `caller_resume` launch row, or its newest `launch_unrecorded` audit row (which carries the
// attributed identity in `agent_id`). A `host_launch` successor pane is deliberately not matched.
import type Database from '../../sqlite/sync-database'
import type { AgentRow } from './agent-directory-types'
import { attributedIdentityForSession } from './caller-resume-launch-preferences'
import type { OrchestrationDb } from './db'

const UNRECORDED_HELD_REASONS = new Set([
  'resume_target_owned_by_pane_without_live_pty',
  'resume_target_owned_by_pane_without_live_agent'
])

function boundElsewhere(row: AgentRow | undefined, paneKey: string): boolean {
  return (
    row !== undefined &&
    row.derived === 0 &&
    row.tombstoned_at === null &&
    row.pane_key !== null &&
    row.pane_key !== paneKey
  )
}

export function paneCallerResumedIntoHeldIdentity(
  db: OrchestrationDb,
  raw: Database.Database,
  hostId: string,
  paneKey: string
): boolean {
  try {
    const launch = db.newestLaunchForPane(hostId, paneKey)
    if (launch) {
      return (
        launch.evidence === 'caller_resume' &&
        boundElsewhere(
          attributedIdentityForSession(
            db,
            hostId,
            launch.execution_host_id,
            launch.session_id,
            paneKey
          ),
          paneKey
        )
      )
    }
    const unrecorded = raw
      .prepare(
        `SELECT agent_id, reason_code FROM agent_audit
         WHERE actor_pane_key = ? AND verb = 'launch_unrecorded' AND actor_host_id = ?
         ORDER BY seq DESC LIMIT 1`
      )
      .get(paneKey, hostId) as { agent_id: string | null; reason_code: string | null } | undefined
    if (!unrecorded?.agent_id || !UNRECORDED_HELD_REASONS.has(unrecorded.reason_code ?? '')) {
      return false
    }
    return boundElsewhere(db.getAgentById(unrecorded.agent_id), paneKey)
  } catch {
    return false
  }
}
