// S10-21a C7b (D-R110 Addendum 22(v)): "before minting, if the pane's newest admission audit of
// any verb (EITHER generation) is UNRECORDED and newer than the row's recorded_at → Layer 3."
// Reuses agent-lineage-mismatch.ts's `newestUnrecordedAdmissionThisGeneration` query SHAPE
// (newest ADMISSION_AUDIT_VERBS row by pane suffix) but drops its generation-bound gate — that
// gate exists there to stop a STALE prior-generation audit from suppressing a CURRENT contest;
// the sweep's own question runs the other way (a restart is always a prior generation reading a
// row), so "either generation" is what Addendum 22(v) states explicitly.
import type Database from '../../sqlite/sync-database'
import { paneSuffix } from './agent-restore-rebind-predicate'
import { ADMISSION_AUDIT_VERBS } from '../../ipc/agent-launch-admission-support'

/** True when the pane's own newest admission audit (any generation) is `launch_unrecorded` and
 * at least as new as `recordedAt` — the row about to be resumed is superseded by a launch that
 * failed to record, so resuming it would silently restore an older conversation over a newer,
 * unrecorded one. */
export type NewestAdmissionUnrecordedResult =
  | { unrecorded: true; reasonCode: string }
  | { unrecorded: false }

export function isNewestAdmissionUnrecordedAndNewer(
  db: Database.Database,
  paneKey: string,
  recordedAt: string
): NewestAdmissionUnrecordedResult {
  const placeholders = ADMISSION_AUDIT_VERBS.map(() => '?').join(', ')
  const audit = db
    .prepare(
      `SELECT verb, reason_code, at FROM agent_audit
         WHERE substr(actor_pane_key, instr(actor_pane_key, ':') + 1) = ?
           AND verb IN (${placeholders})
         ORDER BY seq DESC LIMIT 1`
    )
    .get(paneSuffix(paneKey), ...ADMISSION_AUDIT_VERBS) as
    | { verb: string; reason_code: string | null; at: string }
    | undefined
  if (!audit || audit.verb !== 'launch_unrecorded' || audit.reason_code === null) {
    return { unrecorded: false }
  }
  if (audit.at < recordedAt) {
    return { unrecorded: false }
  }
  return { unrecorded: true, reasonCode: audit.reason_code }
}
