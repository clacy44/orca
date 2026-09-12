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
  /** [R142b] The ticket's own dead-holder-adoption signal, carried through unchanged — see
   * RestoreTicketPayload's field of the same name for why. */
  adoptionSignal?: 'IDENTITY' | 'D1' | 'GEN_ABSENCE' | 'SAME_GEN_PTY_ABSENCE'
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

export type HostResumeHolderRefusal =
  | 'restore_holder_moved'
  | 'restore_holder_current_generation'
  // [R142b] A SAME_GEN_PTY_ABSENCE adoption's own live re-verification, inside this lock, found
  // the holder no longer settled-absent (a connected pty) — distinct from the plain
  // 'restore_holder_current_generation' refusal below, which fires when no such proof was ever
  // offered for the current-generation case at all.
  | 'restore_holder_same_generation_live'

/** [S10-21d b3b, D-R163 H1 fix] Re-reads predecessor-pane holding + generation freshly INSIDE
 * the pane lock, right before the write — a launcher restore (evidence 'host_restore') evaluated
 * DEC-3 well before this lock, so a holder relaunch in between would otherwise let the
 * unconditional supersede delete a LIVE pane's binding. Scoped to 'host_restore': the sweep's own
 * restore never sets `predecessorPaneKey` to anything this re-check would catch differently.
 *
 * [R142b] A current-generation holder ordinarily refuses outright (`restore_holder_current_
 * generation`) — DEC-3's own same-generation branch requires that outcome for every case that
 * did not already prove SAME_GEN_PTY_ABSENCE. When the ticket DOES carry that signal, the
 * predicate's own proof (identity-dead + D2 absence + settle window) was taken BEFORE this
 * lock, separated from this write by `createTerminal`'s whole async spawn path — so it is
 * re-verified here, live, via `findConnectedPtyForPane` (the SAME accessor the adoption
 * predicate used) before trusting it. No fresh controller-inventory read is available inside
 * this admission context (`AgentLaunchAdmissionContext` carries no inventory accessor) — the
 * connected-pty check plus the `restore_holder_moved` re-read immediately above are the
 * re-verification this fix can perform without adding one; see the commit body for why an
 * inventory re-read was left out here. */
export function checkHostResumeHolderUnmoved(
  db: OrchestrationDb,
  hostId: string,
  launchGeneration: string,
  sessionId: string,
  admission: HostResumeAdmission,
  findConnectedPtyForPane: (paneKey: string) => boolean
): HostResumeHolderRefusal | null {
  if (admission.evidence !== 'host_restore' || admission.predecessorPaneKey === null) {
    return null
  }
  if (db.paneHoldingSession(hostId, sessionId) !== admission.predecessorPaneKey) {
    return 'restore_holder_moved'
  }
  const holderRow = db.newestLaunchForPane(hostId, admission.predecessorPaneKey)
  if (holderRow?.launch_generation !== launchGeneration) {
    return null
  }
  if (admission.adoptionSignal !== 'SAME_GEN_PTY_ABSENCE') {
    return 'restore_holder_current_generation'
  }
  return findConnectedPtyForPane(admission.predecessorPaneKey)
    ? 'restore_holder_same_generation_live'
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
  ctx: {
    hostId: string
    launchGeneration: string
    launchPreferences?: HostResumePrefs
    /** [R142b] The SAME accessor the dead-holder-adoption predicate used, threaded through so
     * checkHostResumeHolderUnmoved's own live re-verification never needs a global. */
    findConnectedPtyForPane: (paneKey: string) => boolean
  },
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
    write.admission,
    ctx.findConnectedPtyForPane
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
