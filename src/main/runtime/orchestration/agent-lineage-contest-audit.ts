// S10-21a C6/C6a/C6b + S10-21c B4 (chore split): the CONTEST half of Layer 1's detection surface
// — the `unrecorded_launch` honesty floor and the foreign-id mismatch alarm — moved out of
// agent-lineage-mismatch.ts verbatim so that file stays under the max-lines ratchet once B4's
// four-conjunct reconciliation and bootstrap arms land beside it. Pure move: same queries, same
// dedupe rule, same attribution, same console.warn; `refusalNote` is B4's only addition.
import type Database from '../../sqlite/sync-database'
import type { AgentLaunchSessionRow } from './agent-launch-sessions'
import { paneSuffix } from './agent-restore-rebind-predicate'
import { writeAgentAudit } from './agent-audit-log'
import { ADMISSION_AUDIT_VERBS } from '../../ipc/agent-launch-admission-support'

export const MISMATCH_AUDIT_VERB = 'session_identity_mismatch'

/** The subset of `LiveHookReportMismatchParams` this half reads. Declared structurally rather
 * than imported so the split introduces no import cycle between the two halves. */
export type LineageContestParams = {
  hostId: string
  paneKey: string
  reportedSessionId: string
  anchorCorroborated: boolean
  launchGeneration: string
}

/** [Ruling 34 Addendum 18(iii)/19, D-R108 R1; Ruling 34 Addendum 20 (c)] (a) selects the pane's
 * newest admission audit of ANY verb in the shared `ADMISSION_AUDIT_VERBS` constant (not just
 * 'launch_unrecorded') and downgrades ONLY when THAT newest one
 * is itself the unrecorded outcome — a later launch_self_resume/launch_refused/launch (contest)
 * audit, or a later plain HOST_MINTED/HOST_RESUME launch (no audit, but a newer `row`), must
 * restore normal classification, not be shadowed by an older unrecorded audit. (b) generation-
 * bound: `row.launch_generation` must equal `params.launchGeneration` — agent_audit carries no
 * generation column to filter the audit query itself, so the launch ROW's own generation is the
 * anchor; a stale prior-generation row (and whatever admission history is attached to it) can
 * never suppress a genuine contest in the CURRENT generation. (c) resolved by pane SUFFIX, same
 * rule as `newestLaunchForPaneSuffix`. */
export function newestUnrecordedAdmissionThisGeneration(
  db: Database.Database,
  params: LineageContestParams,
  row: AgentLaunchSessionRow
): string | undefined {
  if (row.launch_generation !== params.launchGeneration) {
    return undefined
  }
  const placeholders = ADMISSION_AUDIT_VERBS.map(() => '?').join(', ')
  const audit = db
    .prepare(
      `SELECT verb, reason_code, at FROM agent_audit
         WHERE substr(actor_pane_key, instr(actor_pane_key, ':') + 1) = ?
           AND verb IN (${placeholders})
         ORDER BY seq DESC LIMIT 1`
    )
    .get(paneSuffix(params.paneKey), ...ADMISSION_AUDIT_VERBS) as
    | { verb: string; reason_code: string | null; at: string }
    | undefined
  if (!audit || audit.verb !== 'launch_unrecorded' || audit.reason_code === null) {
    return undefined
  }
  // Newer-or-equal than the launch row means the admission's LAST word on this pane, this
  // generation, was "nothing recorded, here's why" — a later real launch (a fresher `row`)
  // supersedes an earlier unrecorded audit even though both share the same generation id.
  return audit.at >= row.recorded_at ? audit.reason_code : undefined
}

/** The foreign-id mismatch alarm (T31/T33): one audit row, `verb: 'session_identity_mismatch'`,
 * `outcome: 'contested'`, naming both the recorded and reported ids. [Ruling 34 Addendum 18,
 * correcting Addendum 17's error] UNCONDITIONAL for any NEW fact — the caller (the runtime-layer
 * wiring, C6a item 6) is responsible for its OWN notice clamp via `writeHostNoticeToPane`, keyed
 * per agentId when `row.agent_id` is non-null else per pane, 24h window — that is the ONLY rate
 * clamp; this function never rate-limits by time. [S10-21a C6c, Ruling 34 Addendum 20] What it
 * DOES do is DEDUPE — not clamp: a repeated hook report producing the exact same
 * (recorded, reported) pair as the pane's own newest `session_identity_mismatch`/`contested`
 * audit row writes nothing more (that fact is already on record); ANY new fact — a different
 * reported id, a different recorded id, or the newest audit being some other outcome entirely
 * (e.g. `unrecorded_launch`, or B4's `reconciled`) — still audits unconditionally, no matter how
 * recently. [S10-21c B4] `refusalNote` rides the SAME reason code rather than a second audit row,
 * so a persistently uncovered agent type is recorded once per new fact instead of once per hook
 * report, and the dedupe above keeps working unchanged. */
export function raiseMismatchAlarm(
  db: Database.Database,
  row: AgentLaunchSessionRow,
  params: LineageContestParams,
  refusalNote?: string
): string {
  // [F2, D-R125] An uncorroborated report naming a pane other than the row's own owner is an
  // unauthenticated claim — attribute the audit (and notice, session-identity-mismatch-alarm.ts)
  // to the row's real pane, never the claimant, and record the claimed key as a reason fragment.
  const isUncorroboratedClaimant = !params.anchorCorroborated && params.paneKey !== row.pane_key
  const attributedPaneKey = isUncorroboratedClaimant ? row.pane_key : params.paneKey
  const claimant = isUncorroboratedClaimant ? ` uncorroborated_claimant=${params.paneKey}` : ''
  const note = refusalNote ? ` ${refusalNote}` : ''
  const reasonCode = `recorded=${row.session_id} reported=${params.reportedSessionId}${claimant}${note}`
  const newest = db
    .prepare(
      `SELECT outcome, reason_code FROM agent_audit
         WHERE actor_pane_key = ? AND verb = 'session_identity_mismatch'
         ORDER BY seq DESC LIMIT 1`
    )
    .get(attributedPaneKey) as { outcome: string; reason_code: string | null } | undefined
  const isDuplicateOfNewest =
    newest !== undefined && newest.outcome === 'contested' && newest.reason_code === reasonCode
  if (!isDuplicateOfNewest) {
    writeAgentAudit(db, {
      agentId: row.agent_id,
      actorPaneKey: attributedPaneKey,
      actorHostId: params.hostId,
      verb: MISMATCH_AUDIT_VERB,
      outcome: 'contested',
      reasonCode
    })
  }
  // [§2.6 item 4, D-R107 LOW-1/fix item 7] Structured console.warn so it lands in the service
  // journal on the VPS, same as §2.6's contested-lineage alarm requires for Layer 2 — kept
  // unconditional (Addendum 20 scopes the dedupe to "the audit write" only).
  console.warn('[S10-21a] session_identity_mismatch', {
    hostId: params.hostId,
    paneKey: attributedPaneKey,
    agentId: row.agent_id,
    recordedSessionId: row.session_id,
    reportedSessionId: params.reportedSessionId,
    deduped: isDuplicateOfNewest
  })
  return attributedPaneKey
}
