// S10-21d b3 (DEC-2): the HOST_RESUME arm's own RecordLaunchParams/onRowDeleted builders, split
// out of agent-launch-admission.ts to stay under the max-lines ratchet (that file sat at the
// wall before this brief). Pure — no IO, no side effects besides the returned closure.
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { launchPrefsForCtx } from './agent-launch-admission-support'
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

export type HostResumeHolderRefusal = 'restore_holder_moved' | 'restore_holder_current_generation'

/** [S10-21d b3b, D-R163 H1 fix] Re-reads predecessor-pane holding + generation freshly INSIDE
 * the pane lock, right before the write — a launcher restore (evidence 'host_restore') evaluated
 * DEC-3 well before this lock, so a holder relaunch in between would otherwise let the
 * unconditional supersede delete a LIVE pane's binding. Scoped to 'host_restore': the sweep's own
 * restore never sets `predecessorPaneKey` to anything this re-check would catch differently. */
export function checkHostResumeHolderUnmoved(
  db: OrchestrationDb,
  hostId: string,
  launchGeneration: string,
  sessionId: string,
  admission: HostResumeAdmission
): HostResumeHolderRefusal | null {
  if (admission.evidence !== 'host_restore' || admission.predecessorPaneKey === null) {
    return null
  }
  if (db.paneHoldingSession(hostId, sessionId) !== admission.predecessorPaneKey) {
    return 'restore_holder_moved'
  }
  const holderRow = db.newestLaunchForPane(hostId, admission.predecessorPaneKey)
  return holderRow?.launch_generation === launchGeneration
    ? 'restore_holder_current_generation'
    : null
}

/** [S10-21d b3b, D-R163 H1/H2 LOW] One call-site wrapper for the admission's HOST_RESUME arm:
 * runs the fresh re-check (see checkHostResumeHolderUnmoved) then builds the record-launch
 * params — collapses the call site to a few lines, keeping agent-launch-admission.ts under its
 * own 300-line budget regardless of how the formatter reflows individual call expressions.
 * [compose bC] `ctx.launchPreferences` (R118) is spread onto the built params here too — both
 * lanes' effects survive from one call site (brief bC surface (b)). */
export function resolveHostResumeRecordLaunch(
  db: OrchestrationDb,
  ctx: { hostId: string; launchGeneration: string; launchPreferences?: HostResumePrefs },
  write: {
    paneKey: string
    agentType: string
    sessionId: string
    admission: HostResumeAdmission
    refuse: (reasonCode: HostResumeHolderRefusal) => never
  }
): RecordLaunchParams {
  const holderMoved = checkHostResumeHolderUnmoved(
    db,
    ctx.hostId,
    ctx.launchGeneration,
    write.sessionId,
    write.admission
  )
  if (holderMoved) {
    write.refuse(holderMoved)
  }
  return {
    ...buildHostResumeRecordLaunchParams(
      ctx.hostId,
      write.paneKey,
      write.agentType,
      write.sessionId,
      write.admission
    ),
    ...launchPrefsForCtx(ctx.launchPreferences)
  }
}

type HostResumePrefs = { model?: string; effort?: string }
