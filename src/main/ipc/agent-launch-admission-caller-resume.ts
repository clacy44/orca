// Artifact 10z.5 R287 (chair ruling D-R241): the caller_resume arm's liveness refusal, project-scope
// write gate and held-holder unrecorded outcome. Split out of agent-launch-admission.ts (max-lines).
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import { encodeClaudeProjectPaths } from '../ai-vault/session-scanner-scope-discovery'
import { attributedIdentityForSession } from '../runtime/orchestration/caller-resume-launch-preferences'
import type { ControllerInventory } from '../runtime/orchestration/agent-process-identity'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import {
  liveReportStandsElsewhere,
  type LiveReportPaneReporter,
  type LiveReportRuntimeDeps
} from '../runtime/orchestration/live-report-liveness'
import { resolveResumeTranscript } from '../startup/resolve-resume-transcript'
import { ResumeTargetLiveRefusedError } from './agent-launch-admission-errors'
import {
  audit,
  passThrough,
  type AdmittedLaunch,
  type AgentLaunchAdmissionContext
} from './agent-launch-admission-support'

/** `null` on the admission ctx = unwired (rules 1-2 skipped). The runtime satisfies it structurally. */
export type CallerResumeLivenessDeps = LiveReportRuntimeDeps & {
  confirmClaudeForegroundOnPane: (paneKey: string) => Promise<boolean>
  liveReportPanesForSession: (
    sessionId: string,
    opts?: { excludePaneKey?: string }
  ) => LiveReportPaneReporter[] | null
  takeControllerInventoryForSweep: () => Promise<ControllerInventory | null>
  terminalHandleForPane: (paneKey: string) => string | null
  manifestChairForSession: (sessionId: string) => Promise<{ name: string } | null>
}

type Via = 'claude_foreground' | 'hook_report'

async function refuseLive(
  db: OrchestrationDb,
  ctx: AgentLaunchAdmissionContext,
  deps: CallerResumeLivenessDeps,
  paneKey: string,
  x: string,
  panes: string[],
  via: Via
): Promise<never> {
  const reason = `resume_target_owned_by_another_pane holder=${panes.join(',')} via=${via}`
  audit(db, paneKey, ctx.hostId, 'launch_refused', 'refused', reason.slice(0, 200))
  const holder = panes[0] ?? 'unknown'
  const handle = deps.terminalHandleForPane(holder)
  const chair = await deps.manifestChairForSession(x).catch(() => null)
  const named = handle ? `${holder} (${handle})` : holder
  const what = via === 'claude_foreground' ? 'is already running in' : 'is still reported live by'
  throw new ResumeTargetLiveRefusedError(
    `Claude session ${x} ${what} pane ${named}; Orca refused to start a second process on the same conversation.`,
    {
      sessionId: x,
      holderPaneKey: holder,
      holderTerminal: handle,
      via,
      chair: chair?.name ?? null,
      nextSteps: [
        handle
          ? `Use that pane, or close it first: orca terminal close --terminal ${handle}`
          : `Use pane ${holder}, or close it first.`,
        chair
          ? `After that pane is closed, recover the chair with \`orca chairs restore --only ${chair.name}\` — run it twice at least 10 s apart.`
          : 'After that pane is closed, run this resume again.'
      ]
    }
  )
}

/** Rules 1-2: refuse when X's holder runs claude in its foreground, or a hook report of X stands
 * under DEC-3 (`liveReportStandsElsewhere`, verbatim). Audits, then throws. */
export async function refuseIfResumeTargetLive(
  db: OrchestrationDb,
  ctx: AgentLaunchAdmissionContext,
  paneKey: string,
  x: string
): Promise<void> {
  const deps = ctx.callerResume
  if (!deps) {
    return
  }
  const holder = db.paneHoldingSession(ctx.hostId, x)
  if (
    holder !== undefined &&
    holder !== paneKey &&
    deps.findConnectedPtyForPane(holder) &&
    (await deps.confirmClaudeForegroundOnPane(holder).catch(() => false))
  ) {
    await refuseLive(db, ctx, deps, paneKey, x, [holder], 'claude_foreground')
  }
  const listed = deps.liveReportPanesForSession(x, { excludePaneKey: holder })
  const reporters = listed === null ? null : listed.filter((r) => r.paneKey !== paneKey)
  if (reporters !== null && reporters.length === 0) {
    return
  }
  const inventory =
    reporters === null ? null : await deps.takeControllerInventoryForSweep().catch(() => null)
  if (!liveReportStandsElsewhere(reporters, inventory, ctx.hostId, deps)) {
    return
  }
  const standing = (reporters ?? [])
    .filter((r) => liveReportStandsElsewhere([r], inventory, ctx.hostId, deps))
    .map((r) => r.paneKey)
  await refuseLive(
    db,
    ctx,
    deps,
    paneKey,
    x,
    standing.length > 0 ? standing : [holder ?? 'unknown'],
    'hook_report'
  )
}

/** Rule 4: with no holder, a caller resume is recorded only when X's transcript resolves inside the
 * new pane's own Claude project directory. Absent cwd, a non-claude agent or a holder skips it. */
export async function resumeTranscriptOutsidePaneProject(
  db: OrchestrationDb,
  ctx: AgentLaunchAdmissionContext,
  x: string,
  spawnOptions: PtySpawnOptions
): Promise<boolean> {
  const agentType = spawnOptions.launchAgent ?? 'claude'
  const cwd = spawnOptions.cwd
  if (agentType !== 'claude' || !cwd || db.paneHoldingSession(ctx.hostId, x) !== undefined) {
    return false
  }
  const configDir = spawnOptions.env?.CLAUDE_CONFIG_DIR
  const root = configDir ? join(configDir, 'projects') : join(homedir(), '.claude', 'projects')
  try {
    for (const encoded of encodeClaudeProjectPaths(cwd)) {
      const hit = await resolveResumeTranscript(agentType, x, {
        claudeProjectsDir: join(root, encoded)
      })
      if (hit && 'path' in hit) {
        return false
      }
    }
  } catch {
    return false
  }
  return true
}

/** Rule 6: the write was refused because a holder exists (it passed rules 1-2). The spawn proceeds,
 * unrecorded; the audit row carries X's attributed identity in `agent_id`. */
export function unrecordedHeldResume(
  db: OrchestrationDb,
  ctx: AgentLaunchAdmissionContext,
  paneKey: string,
  x: string,
  spawnOptions: PtySpawnOptions
): AdmittedLaunch {
  const holder = db.paneHoldingSession(ctx.hostId, x)
  const reasonCode =
    holder !== undefined && ctx.findConnectedPtyForPane(holder)
      ? 'resume_target_owned_by_pane_without_live_agent'
      : 'resume_target_owned_by_pane_without_live_pty'
  const agentId = attributedIdentityForSession(db, ctx.hostId, ctx.executionHostId, x)?.id ?? null
  audit(db, paneKey, ctx.hostId, 'launch_unrecorded', 'admitted', reasonCode, agentId)
  ctx.notice(paneKey, 'launch_unrecorded', reasonCode)
  return passThrough(spawnOptions, 'unrecorded')
}
