// S10-21a C7b/C7i: shared test fixtures for the restore-sweep test suite, split out so neither
// restore-registered-agent-panes.test.ts nor restore-registered-agent-panes-decision-table.test.ts
// has to duplicate them (and to stay under the max-lines ratchet on each). NOT itself a test.
import { vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import type { AgentRow } from '../runtime/orchestration/agent-directory-types'
import type { RestoreTicketId, RestoreTicketMintArgs } from '../runtime/restore-ticket-registry'
import type { IncumbentEvidence } from '../runtime/incumbent-death'
import type { ControllerInventory } from '../runtime/orchestration/agent-process-identity'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { RestoreSweepDeps } from './restore-registered-agent-panes'

export const HOST_ID = 'local'
export const EXEC_HOST_ID = 'local'
export const LAUNCH_GEN = 'gen-current'
// [D-R110 B1] the row is seeded under a DIFFERENT, PRIOR generation than the current one — the
// production invariant every restart actually presents.
export const PRIOR_GEN = 'gen-prior'

export function emptyInventory(overrides: Partial<ControllerInventory> = {}): ControllerInventory {
  return {
    allLivePtyIds: new Set(),
    terminalIdentityByPtyId: new Map(),
    ...overrides
  }
}

export function insertAgent(
  db: Database.Database,
  overrides: Partial<AgentRow> & { id: string; display_name: string; pane_key: string | null }
): void {
  db.prepare(
    `INSERT INTO agents (
       id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
       worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
       quarantined_at, tombstoned_at, origin_kind, origin_pane_key, origin_handle,
       origin_host_id
     ) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, 'idle', 0, 0, NULL,
       NULL, 'pane', ?, NULL, ?)`
  ).run(
    overrides.id,
    overrides.display_name,
    overrides.host_id ?? HOST_ID,
    overrides.pane_key,
    overrides.process_incarnation ?? null,
    overrides.worktree_id ?? 'wt-1',
    overrides.pane_key,
    overrides.origin_host_id ?? HOST_ID
  )
}

/** [C7i] Mirrors orca-runtime.ts's own `collectIncumbentEvidence` shape closely enough for the
 * sweep's decision logic: `ptyState`/`terminalIdentity` read the SAME pre-fetched round the d1-3
 * fields were computed from (or `preFetchedInventory` directly when `ptyId` is undefined). */
export function defaultCollectIncumbentEvidence(
  paneKey: string,
  ptyId: string | undefined,
  _now?: number,
  preFetchedInventory?: ControllerInventory | null
): Promise<IncumbentEvidence> {
  const inv = preFetchedInventory ?? null
  return Promise.resolve({
    paneKey,
    ptyId,
    d1: { ptyKnownToRuntime: false, exitObservedThisGeneration: true },
    d2: {
      inventory:
        ptyId === undefined
          ? 'unknown'
          : inv === null
            ? 'unknown'
            : inv.allLivePtyIds.has(ptyId)
              ? 'present'
              : 'absent'
    },
    d3: { liveNow: false, firstObservedNotLiveAt: null, now: 0 },
    ptyLive: (pid: string) => inv?.allLivePtyIds.has(pid) ?? false,
    ptyState: (pid: string) =>
      inv === null ? 'unknown' : inv.allLivePtyIds.has(pid) ? 'present' : 'absent',
    terminalIdentity: (pid: string) => inv?.terminalIdentityByPtyId.get(pid),
    // [C7k] Default fixture has no separate "connected now" model — false unless a test
    // overrides `collectIncumbentEvidence` itself to exercise the union with `ptyState`.
    ptyConnectedNow: () => false
  })
}

export function baseDeps(
  db: OrchestrationDb,
  overrides: Partial<RestoreSweepDeps> = {}
): RestoreSweepDeps {
  return {
    getOrchestrationDb: () => db,
    getOrchestrationCompatibilityHostId: () => HOST_ID,
    getLaunchGenerationId: () => LAUNCH_GEN,
    findConnectedLeafOccupant: () => undefined,
    isLeafInPersistedLayout: () => true,
    getPersistedPtyIdForLeaf: () => undefined,
    ensureAgentSession: vi.fn(),
    takeControllerInventoryForSweep: async () => emptyInventory(),
    getSelfResumeWatermark: () => null,
    collectIncumbentEvidence: defaultCollectIncumbentEvidence,
    getTerminalProcessIncarnation: () => null,
    mintRestoreTicket: (payload: RestoreTicketMintArgs) =>
      JSON.stringify(payload) as unknown as RestoreTicketId,
    notifyRebindDelivery: vi.fn(),
    ...overrides
  }
}
