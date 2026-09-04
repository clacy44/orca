// S10-21a C3-v2: the `AdmittedLaunch` type and its two smallest builders, split out of
// agent-launch-admission.ts to stay under the repo's max-lines budget.
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type { PtySpawnResult } from '../providers/pty-spawn-result'
import type { OrchestrationDb } from '../runtime/orchestration/db'

export type AdmittedLaunch = {
  spawnOptions: PtySpawnOptions
  /** [§C.6] Compares the spawn's actual surface against the pane admission wrote for. */
  confirm: (result: PtySpawnResult) => void
  /** [§C.6] Idempotent, keyed on the same row. `fromEnsureFailure` selects the non-deleting path
   * (`launch_ensure_failed_after_spawn`) used by the `agentSessionOwners.ensure` catch, which runs
   * after the spawn callback returned and may still have a live process. */
  compensate: (fromEnsureFailure?: boolean) => void
}

export function passThrough(spawnOptions: PtySpawnOptions): AdmittedLaunch {
  return { spawnOptions, confirm: () => {}, compensate: () => {} }
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
