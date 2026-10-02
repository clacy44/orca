// D-30a / Ruling 36 (train 10z.9, arm H): decides whether the startup sweep's HOST_RESUME relaunch
// of a pane also carries the chair re-anchor prompt. Split out of restore-registered-agent-panes.ts
// to stay under the max-lines ratchet.
import { readHostScopedManifestChairs } from '../runtime/orchestration/chair-succession-manifest-entry'
import type { ChairsManifestEntry } from '../runtime/orchestration/chairs-manifest'
import { chairForPane } from '../runtime/orchestration/daemon-loss-chair-verdict'
import type { AgentLaunchSessionRow } from '../runtime/orchestration/agent-launch-sessions'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { auditSweepNote } from '../runtime/orchestration/restore-sweep-audit'
import type { OccupantLiveness } from '../runtime/orchestration/restore-sweep-decision'
import type { SweepOccupant } from '../runtime/orchestration/restore-sweep-evidence'
import type { RestoreTicketId } from '../runtime/restore-ticket-registry'
import type { RestoreSweepDeps } from './restore-sweep-types'

/** True iff the sweep is relaunching a manifest chair whose own pane holds no live or unknown pty.
 * Never throws: any failure reads as "not a chair", so the chair resumes without a prompt. */
export async function sweepReanchorEligible(
  deps: RestoreSweepDeps,
  agentId: string,
  launchRow: AgentLaunchSessionRow,
  occupant: SweepOccupant | undefined,
  occupantLiveness: OccupantLiveness | undefined
): Promise<boolean> {
  const paneKey = launchRow.pane_key
  // Why: a live or unknown pty on the chair's own pane may be the chair itself; a prompt would make a duplicate act.
  if (occupant?.paneKey === paneKey && occupantLiveness !== 'absent') {
    return false
  }
  try {
    if (!(await deps.isManifestChairPane?.(paneKey))) {
      return false
    }
    auditSweepNote(
      deps.getOrchestrationDb(),
      deps.getOrchestrationCompatibilityHostId(),
      paneKey,
      agentId,
      'reanchor_armed'
    )
    return true
  } catch {
    return false
  }
}

/** The in-process-only `internal` argument of the sweep's `ensureAgentSession` call. */
export function hostRestoreInternal(
  ticket: RestoreTicketId,
  hostReanchor: boolean
): { restoreProvenance: { kind: 'host-restore'; ticket: RestoreTicketId }; hostReanchor?: true } {
  return {
    restoreProvenance: { kind: 'host-restore', ticket },
    ...(hostReanchor ? { hostReanchor: true as const } : {})
  }
}

/** `RestoreSweepDeps.isManifestChairPane`: R315's `chairForPane` over the host-scoped manifest,
 * which is read once per sweep (memoised here, so build one per sweep). */
export function createIsManifestChairPane(
  getDb: () => OrchestrationDb,
  getHostId: () => string,
  readChairs: () => Promise<ChairsManifestEntry[] | null> = readHostScopedManifestChairs
): (paneKey: string) => Promise<boolean> {
  let chairs: Promise<ChairsManifestEntry[] | null> | undefined
  return async (paneKey) => {
    chairs ??= readChairs().catch(() => null)
    return chairForPane(getDb(), getHostId(), paneKey, await chairs) !== null
  }
}
