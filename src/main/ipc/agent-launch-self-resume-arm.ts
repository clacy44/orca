// S10-21d b6 (R119 fix 1/2): SELF_RESUME's same-pane/contested split and the derived-row
// contest-or-supersede pattern shared by the caller_resume and HOST_MINTED arms — split out of
// agent-launch-admission.ts to stay under the max-lines ratchet (that file sat at the wall
// before this brief).
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { audit } from './agent-launch-admission-support'

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
