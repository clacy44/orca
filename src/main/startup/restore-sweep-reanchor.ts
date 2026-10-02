// D-30a / Ruling 36 (train 10z.9, arm H): decides whether the startup sweep's HOST_RESUME relaunch
// of a pane also carries the chair re-anchor prompt. Split out of restore-registered-agent-panes.ts
// to stay under the max-lines ratchet.
import { readHostScopedManifestChairs } from '../runtime/orchestration/chair-succession-manifest-entry'
import type { ChairsManifestEntry } from '../runtime/orchestration/chairs-manifest'
import { chairForPane } from '../runtime/orchestration/daemon-loss-chair-verdict'
import {
  launchPreferencesFromRow,
  type AgentLaunchSessionRow
} from '../runtime/orchestration/agent-launch-sessions'
import type { ResumableTuiAgent } from '../../shared/agent-session-resume'
import type { RuntimeEnsureAgentSessionResult } from '../../shared/agent-session-host-authority'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { auditSweepNote } from '../runtime/orchestration/restore-sweep-audit'
import type { ControllerInventory } from '../runtime/orchestration/agent-process-identity'
import type {
  EarlyRowsDecision,
  OccupantLiveness
} from '../runtime/orchestration/restore-sweep-decision'
import type { SweepOccupant } from '../runtime/orchestration/restore-sweep-evidence'
import type { RestoreTicketId } from '../runtime/restore-ticket-registry'
import type { RestoreSweepDeps } from './restore-sweep-types'

/** True iff the sweep's own verdict is "this chair's agent process is gone": a real identity absent from
 * the round, no live or unknown pty on its own pane, a manifest chair, not peer-owned.
 * Never throws: any failure reads as "not eligible", so the chair resumes without a prompt. */
export async function sweepReanchorEligible(
  deps: RestoreSweepDeps,
  launchRow: AgentLaunchSessionRow,
  occupant: SweepOccupant | undefined,
  occupantLiveness: OccupantLiveness | undefined,
  early: Extract<EarlyRowsDecision, { kind: 'proceed' }>,
  inventory: ControllerInventory | null
): Promise<boolean> {
  const paneKey = launchRow.pane_key
  // Why: an unknown identity, or a ptyId live under a newer incarnation, may still be the chair's own process.
  if (
    early.status !== 'dead' ||
    !early.identity ||
    !inventory ||
    inventory.allLivePtyIds.has(early.identity.ptyId)
  ) {
    return false
  }
  // Why: a live or unknown pty on the chair's own pane may be the chair itself; a prompt would make a duplicate act.
  if (occupant?.paneKey === paneKey && occupantLiveness !== 'absent') {
    return false
  }
  try {
    // Why: R315 withholds the re-anchor from a peer-owned pane (daemon-loss-chair-verdict.ts).
    if (deps.getOrchestrationDb().findPeerOwnedAttachmentForPaneKey(paneKey) !== undefined) {
      return false
    }
    return (await deps.isManifestChairPane?.(paneKey)) === true
  } catch {
    return false
  }
}

/** The sweep's one `ensureAgentSession` call. `reanchor_armed` is written only after it returns with the
 * flag set; a failed audit write never fails the restore, which has already launched. */
export async function ensureRestoredAgentSession(
  deps: RestoreSweepDeps,
  agentId: string,
  launchRow: AgentLaunchSessionRow,
  worktreeId: string | null,
  placeAt: { tabId: string; leafId: string } | undefined,
  ticket: RestoreTicketId,
  armed: boolean
): Promise<RuntimeEnsureAgentSessionResult> {
  const created = await deps.ensureAgentSession(
    {
      kind: 'explicit',
      worktree: `id:${worktreeId}`,
      agent: launchRow.agent_type as ResumableTuiAgent,
      providerSession: { key: 'session_id', id: launchRow.session_id },
      presentation: 'background',
      placement: placeAt ? { tabId: placeAt.tabId, leafId: placeAt.leafId } : undefined,
      launchPreferences: launchPreferencesFromRow(launchRow)
    },
    {},
    hostRestoreInternal(ticket, armed)
  )
  if (armed) {
    try {
      auditSweepNote(
        deps.getOrchestrationDb(),
        deps.getOrchestrationCompatibilityHostId(),
        launchRow.pane_key,
        agentId,
        'reanchor_armed'
      )
    } catch {
      // The relaunch already committed; a lost note must not undo it.
    }
  }
  return created
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
