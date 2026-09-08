// S10-21a C3-v2: the `AdmittedLaunch` type and its two smallest builders, split out of
// agent-launch-admission.ts to stay under the repo's max-lines budget.
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type { PtySpawnResult } from '../providers/pty-spawn-result'
import type { RecordLaunchParams } from '../runtime/orchestration/agent-launch-sessions'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { resolveResumeTranscript } from '../startup/resolve-resume-transcript'

// [S10-21d R118, design (a)] Split out of agent-launch-admission.ts (same max-lines-budget
// reason this whole file exists) — takes the narrow shape directly, not
// AgentLaunchAdmissionContext itself, to avoid importing back into the module that imports this
// one. Undefined input (the overwhelming majority of launches) spreads to nothing, so
// params.prefs is omitted and the INSERT writes NULL (design (d)).
export function launchPrefsForCtx(
  launchPreferences: { model?: string; effort?: string } | undefined
): Pick<RecordLaunchParams, 'prefs'> {
  return launchPreferences ? { prefs: { ...launchPreferences, source: 'launch' as const } } : {}
}

/** [S10-21a C7f, D-R114 fix 1] The admission outcome pty.ts's post-spawn-commit gate needs at
 * :6937 — HOST_MINTED and HOST_RESUME both come from `buildRecordedAdmission`; the two
 * SELF_RESUME shapes come from their own `passThrough` calls. Undefined for every other
 * pass-through (uncovered, unrecorded, refused) — the gate never runs for those. */
export type LaunchAdmissionClassification =
  | 'host_resume'
  | 'host_minted'
  | 'self_resume_caller'
  | 'self_resume_host'
  | 'unrecorded'

export type AdmittedLaunch = {
  spawnOptions: PtySpawnOptions
  /** [§C.6] Compares the spawn's actual surface against the pane admission wrote for. */
  confirm: (result: PtySpawnResult) => void
  /** [§C.6] Idempotent, keyed on the same row. `fromEnsureFailure` selects the non-deleting path
   * (`launch_ensure_failed_after_spawn`) used by the `agentSessionOwners.ensure` catch, which runs
   * after the spawn callback returned and may still have a live process. */
  compensate: (fromEnsureFailure?: boolean) => void
  classification?: LaunchAdmissionClassification
  /** [S10-21a C14b, D-R128 F6] The already-registered row's agent id on a `self_resume_caller`
   * pass-through, so the renderer-funnel gate's refresh binds that row specifically (two
   * registered rows can share a pane suffix). */
  registeredAgentId?: string
}

export function passThrough(
  spawnOptions: PtySpawnOptions,
  classification?: LaunchAdmissionClassification,
  registeredAgentId?: string
): AdmittedLaunch {
  return {
    spawnOptions,
    confirm: () => {},
    compensate: () => {},
    ...(classification ? { classification } : {}),
    ...(registeredAgentId ? { registeredAgentId } : {})
  }
}

/** [S10-21c B-final M2/M3, D-R160 medium 2/3] caller_resume's resume-transcript preflight,
 * extracted to stay under agent-launch-admission.ts's own max-lines budget. THREE outcomes,
 * never collapsed: a throw (unguarded filesystem IO, D-R151 HIGH's own reasoning) refuses loudly
 * rather than failing the spawn; `{coverage:'uncovered'}` is S4's own "not covered yet" state,
 * not a claim the target is missing; only a genuine miss/stub-only transcript is
 * `resume_target_absent`. */
export async function preflightResumeTranscript(
  resolve: typeof resolveResumeTranscript,
  agentType: string,
  sessionId: string
): Promise<{ ok: true } | { ok: false; reasonCode: string }> {
  let resumeTranscript: Awaited<ReturnType<typeof resolveResumeTranscript>>
  try {
    resumeTranscript = await resolve(agentType, sessionId)
  } catch {
    return { ok: false, reasonCode: 'resume_preflight_failed' }
  }
  if (resumeTranscript && 'coverage' in resumeTranscript) {
    return { ok: false, reasonCode: 'resume_preflight_uncovered' }
  }
  if (!resumeTranscript || !resumeTranscript.hasTurn) {
    return { ok: false, reasonCode: 'resume_target_absent' }
  }
  return { ok: true }
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
 * absent from this list. TWO consumers share this SAME constant (D-R108 R1(a); [D-R160 low 8]
 * named explicitly, both fail safe): agent-lineage-mismatch.ts's `unrecorded_launch` downgrade,
 * and agent-sweep-unrecorded-check.ts's own sweep-side unrecorded-launch gate — a future
 * admission verb must be added here deliberately, or it is silently excluded from BOTH (fail
 * toward contest / fail toward Layer-3, the safe default in each), never silently included.
 * `agent-launch-admission-audit-verbs.test.ts` greps every verb literal in
 * agent-launch-admission*.ts/pty.ts's contestedLineage and asserts none escapes this list. */
export const ADMISSION_AUDIT_VERBS = [
  'launch_unrecorded',
  'launch_refused',
  'launch_self_resume',
  'launch_surface_diverged',
  'launch_ensure_failed_after_spawn',
  'launch_spawn_failed',
  // [S10-21c B-final F5, D-R159 finding 5] HOST_MINTED/caller_resume superseding a DERIVED
  // registered row's session — a newer 'launch_recorded' row here correctly restores normal
  // classification (never shadowed by an older unrecorded audit), same as every other verb below.
  'launch_recorded',
  'launch'
] as const
