// S10-21d b3 (DEC-2): the HOST_RESUME arm's own RecordLaunchParams/onRowDeleted builders, split
// out of agent-launch-admission.ts to stay under the max-lines ratchet (that file sat at the
// wall before this brief). Pure — no IO, no side effects besides the returned closure.
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type {
  LaunchEvidence,
  RecordLaunchParams
} from '../runtime/orchestration/agent-launch-sessions'

export type HostResumeAdmission = {
  launchGeneration: string
  executionHostId: string
  evidence?: Extract<LaunchEvidence, 'sweep_record' | 'host_restore'>
  /** [DEC-2] null for the launcher's own unheld-session restore. */
  predecessorPaneKey: string | null
}

/** Defaults `evidence` to the sweep's own 'sweep_record' (the only caller before this brief) and
 * converts a null predecessor to `supersedePaneKey: undefined` (no supersede). */
export function buildHostResumeRecordLaunchParams(
  hostId: string,
  paneKey: string,
  agentType: string,
  sessionId: string,
  admission: HostResumeAdmission
): RecordLaunchParams {
  return {
    hostId,
    paneKey,
    agentType,
    sessionId,
    launchGeneration: admission.launchGeneration,
    executionHostId: admission.executionHostId,
    evidence: admission.evidence ?? 'sweep_record',
    supersedePaneKey: admission.predecessorPaneKey ?? undefined
  }
}

/** Nothing to restore when the restore named no predecessor pane (DEC-2's unheld case). */
export function hostResumeOnRowDeleted(
  db: OrchestrationDb,
  hostId: string,
  predecessorPaneKey: string | null
): (() => void) | undefined {
  return predecessorPaneKey === null
    ? undefined
    : () => db.restoreCurrentSessionForPane(hostId, predecessorPaneKey)
}
