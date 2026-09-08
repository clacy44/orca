// S10-21d b6 (R119 fix 1/2/3): SELF_RESUME's same-pane/contested split, the derived-row
// contest-or-supersede pattern shared by the caller_resume and HOST_MINTED arms, and
// SELF_RESUME's own confirm/compensate — split out of agent-launch-admission.ts to stay under
// the max-lines ratchet (that file sat at the wall before this brief).
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type { PtySpawnResult } from '../providers/pty-spawn-result'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import {
  audit,
  type AdmittedLaunch,
  type LaunchAdmissionClassification
} from './agent-launch-admission-support'

export type SelfResumeCtx = {
  hostId: string
  notice: (paneKey: string, verb: string, reasonCode: string) => void
  contestedLineage: (
    claimantPaneKey: string,
    registeredPaneKey: string,
    registeredAgentId: string,
    recordedSessionId: string,
    reportedSessionId: string
  ) => void
}

export type RegisteredRowRef = { id: string; pane_key: string | null; derived: number }

/** [S10-21d b6, R119 fix 1] A pane resuming its OWN newest recorded id is never a contest by
 * itself — reaching here already proved `recordedSessionId === reportedSessionId`. Only a
 * registered row on a DIFFERENT pane key (suffix-matched, `derived-agent-rows.ts`) makes it a
 * contest; the same-pane case gets ONE self-describing audit row instead, never a contest. */
export function auditSelfResume(
  db: OrchestrationDb,
  ctx: SelfResumeCtx,
  paneKey: string,
  reasonCode: 'caller' | 'host',
  registeredRow: RegisteredRowRef | undefined,
  recordedSessionId: string,
  reportedSessionId: string
): void {
  if (reasonCode !== 'caller' || registeredRow === undefined || registeredRow.derived !== 0) {
    audit(db, paneKey, ctx.hostId, 'launch_self_resume', 'admitted', reasonCode)
    return
  }
  const registeredPaneKey = registeredRow.pane_key ?? paneKey
  if (registeredPaneKey === paneKey) {
    audit(
      db,
      paneKey,
      ctx.hostId,
      'launch_self_resume',
      'admitted',
      `self_resume_same_pane recorded=${recordedSessionId} reported=${reportedSessionId} holder=${paneKey}`
    )
    return
  }
  audit(db, paneKey, ctx.hostId, 'launch_self_resume', 'admitted', reasonCode)
  ctx.notice(paneKey, 'launch_self_resume', 'caller')
  ctx.contestedLineage(
    paneKey,
    registeredPaneKey,
    registeredRow.id,
    recordedSessionId,
    reportedSessionId
  )
}

/** [S10-21c B3b/D-R149 MEDIUM 1, S10-21c B-final F5/D-R159 finding 5] Shared by the
 * caller_resume and HOST_MINTED arms: a non-derived registered row's session changing gets
 * `contestedLineage` (now carrying both ids); a DERIVED row gets its own distinct
 * 'launch_recorded'/'derived_row_superseded' audit row instead — never traceless either way. */
export function contestOrSupersedeDerivedRow(
  db: OrchestrationDb,
  ctx: SelfResumeCtx,
  paneKey: string,
  registeredRow: RegisteredRowRef | undefined,
  recordedSessionId: string,
  reportedSessionId: string
): void {
  if (registeredRow === undefined) {
    return
  }
  if (registeredRow.derived === 0) {
    ctx.contestedLineage(
      paneKey,
      registeredRow.pane_key ?? paneKey,
      registeredRow.id,
      recordedSessionId,
      reportedSessionId
    )
    return
  }
  audit(db, paneKey, ctx.hostId, 'launch_recorded', 'admitted', 'derived_row_superseded')
}

/** [S10-21d b6, R119 fix 3] SELF_RESUME writes no row, so `compensate` had nothing to delete —
 * the shared no-op `passThrough` (agent-launch-admission-support.ts) made a spawn failure after
 * this admission silent. `confirm` mirrors `buildRecordedAdmission`'s own (surface-divergence
 * audit); `compensate` audits `launch_spawn_failed`. Never a refusal — stays a pass-through. */
export function selfResumePassThrough(
  db: OrchestrationDb,
  ctx: SelfResumeCtx,
  paneKey: string,
  spawnOptions: PtySpawnOptions,
  classification: LaunchAdmissionClassification,
  registeredAgentId?: string
): AdmittedLaunch {
  let settled = false
  return {
    spawnOptions,
    classification,
    ...(registeredAgentId ? { registeredAgentId } : {}),
    confirm: (spawnResult: PtySpawnResult) => {
      if (settled) {
        return
      }
      settled = true
      const surface = spawnResult.agentSessionEnsure?.owner.surface
      if (surface !== undefined) {
        const actualPaneKey = `${surface.tabId}:${surface.leafId}`
        if (actualPaneKey !== paneKey) {
          audit(db, paneKey, ctx.hostId, 'launch_surface_diverged', 'compensated', null)
          ctx.notice(paneKey, 'launch_surface_diverged', 'launch_surface_diverged')
        }
      }
    },
    compensate: () => {
      if (settled) {
        return
      }
      settled = true
      audit(db, paneKey, ctx.hostId, 'launch_spawn_failed', 'compensated', null)
    }
  }
}
