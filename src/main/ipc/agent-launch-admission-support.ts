// S10-21a C3-v2: the `AdmittedLaunch` type and its two smallest builders, split out of
// agent-launch-admission.ts to stay under the repo's max-lines budget.
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type { PtySpawnResult } from '../providers/pty-spawn-result'
import type { OrchestrationDb } from '../runtime/orchestration/db'

/** [S10-21a C7f, D-R114 fix 1] The admission outcome pty.ts's post-spawn-commit gate needs at
 * :6937 — HOST_MINTED and HOST_RESUME both come from `buildRecordedAdmission`; the two
 * SELF_RESUME shapes come from their own `passThrough` calls. Undefined for every other
 * pass-through (uncovered, unrecorded, refused) — the gate never runs for those. */
export type LaunchAdmissionClassification =
  | 'host_resume'
  | 'host_minted'
  | 'self_resume_caller'
  | 'self_resume_host'

export type AdmittedLaunch = {
  spawnOptions: PtySpawnOptions
  /** [§C.6] Compares the spawn's actual surface against the pane admission wrote for. */
  confirm: (result: PtySpawnResult) => void
  /** [§C.6] Idempotent, keyed on the same row. `fromEnsureFailure` selects the non-deleting path
   * (`launch_ensure_failed_after_spawn`) used by the `agentSessionOwners.ensure` catch, which runs
   * after the spawn callback returned and may still have a live process. */
  compensate: (fromEnsureFailure?: boolean) => void
  classification?: LaunchAdmissionClassification
}

export function passThrough(
  spawnOptions: PtySpawnOptions,
  classification?: LaunchAdmissionClassification
): AdmittedLaunch {
  return {
    spawnOptions,
    confirm: () => {},
    compensate: () => {},
    ...(classification ? { classification } : {})
  }
}

export function audit(
  db: OrchestrationDb,
  paneKey: string | null,
  hostId: string,
  verb: string,
  outcome: string,
  reasonCode: string | null
): void {
  db.writeAgentAudit({
    agentId: null,
    actorPaneKey: paneKey,
    actorHostId: hostId,
    verb,
    outcome,
    reasonCode
  })
}

/** [S10-21a C6c, Ruling 34 Addendum 20] The ONE shared enumeration of every audit verb the
 * launch-admission surface writes — agent-launch-admission.ts's own `audit()` calls, plus
 * pty.ts's `contestedLineage` (R(i), verb 'launch'). A plain HOST_MINTED/HOST_RESUME success
 * writes NO audit row at all (the launch row write itself is the record), so it is deliberately
 * absent from this list. agent-lineage-mismatch.ts's `unrecorded_launch` downgrade consumes this
 * SAME constant (D-R108 R1(a)) — a future admission verb must be added here deliberately, or it
 * is silently excluded from the downgrade (fail toward contest, the safe default), never silently
 * included. `agent-launch-admission-audit-verbs.test.ts` greps every verb literal in
 * agent-launch-admission*.ts/pty.ts's contestedLineage and asserts none escapes this list. */
export const ADMISSION_AUDIT_VERBS = [
  'launch_unrecorded',
  'launch_refused',
  'launch_self_resume',
  'launch_surface_diverged',
  'launch_ensure_failed_after_spawn',
  'launch_spawn_failed',
  'launch'
] as const
