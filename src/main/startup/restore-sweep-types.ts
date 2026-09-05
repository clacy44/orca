// S10-21a C7/C7k: the restore sweep's public dependency and result types, split out of
// restore-registered-agent-panes.ts to stay under the max-lines ratchet.
import type { RebindRestoredPaneResult } from '../runtime/orchestration/agent-restore-rebind'
import type { IncumbentEvidence } from '../runtime/incumbent-death'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type {
  RuntimeAgentSessionRpcCaller,
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../shared/agent-session-host-authority'
import type { RestoreTicketId, RestoreTicketMintArgs } from '../runtime/restore-ticket-registry'
import type { ControllerInventory } from '../runtime/orchestration/agent-process-identity'

export type RestoreSweepDeps = {
  getOrchestrationDb(): OrchestrationDb
  getOrchestrationCompatibilityHostId(): string
  getLaunchGenerationId(): string
  /** [D-R110 B3] Liveness-only occupant lookup — `orca-runtime.ts#findConnectedLeafOccupant`.
   * Distinguishes the pane's own live session from anything else on the leaf.
   * [C7h, Ruling 34 Addendum 26] `tabId` scopes the match — a leaf id alone matches the first
   * tab in map order that reused it. */
  findConnectedLeafOccupant(
    leafId: string,
    tabId?: string | null
  ): { paneKey: string; ptyId: string } | undefined
  /** [D-R110 fix 6] Whether the tab's persisted layout TREE still resolves this leaf. */
  isLeafInPersistedLayout(tabId: string, leafId: string, hostId?: string | null): boolean
  /** [D-R110 fix 4] The persisted ptyId for a leaf (evidence input only, never occupancy). */
  getPersistedPtyIdForLeaf(
    tabId: string,
    leafId: string,
    hostId?: string | null
  ): string | undefined
  ensureAgentSession(
    request: RuntimeEnsureAgentSessionRequest,
    caller: RuntimeAgentSessionRpcCaller,
    internal: { restoreProvenance: { kind: 'host-restore'; ticket: RestoreTicketId } }
  ): Promise<RuntimeEnsureAgentSessionResult>
  /** [C7i, Ruling 34 Addendum 27] ONE round for the WHOLE sweep — called once by
   * `runRestoreSweepBody`, before the candidate loop, and the same result handed to every
   * candidate. Retries once on a null round (orca-runtime.ts's own implementation). */
  takeControllerInventoryForSweep(): Promise<ControllerInventory | null>
  /** [C7j, Ruling 34 Addendum 27 row 7] The watermark captured once, before openMainWindow,
   * under the restore-sweep lock (`orca-runtime.ts#captureSelfResumeWatermark`) — null when the
   * orchestration DB was not yet attached at that capture point (row 7 is then skipped for the
   * whole sweep, never moved to a different capture site). Read once by `runRestoreSweepBody`,
   * same shared-round shape as `takeControllerInventoryForSweep`. */
  getSelfResumeWatermark(): number | null
  collectIncumbentEvidence(
    paneKey: string,
    ptyId: string | undefined,
    now?: number,
    preFetchedInventory?: ControllerInventory | null
  ): Promise<IncumbentEvidence>
  getTerminalProcessIncarnation(handle: string): string | null
  /** In-process only (INV-P-021) — see orca-runtime.ts's `mintRestoreTicket`. */
  mintRestoreTicket(payload: RestoreTicketMintArgs): RestoreTicketId
  /** [C9 hand-off, D-I80] `orca-runtime.ts#notifyRebindDelivery` — called once after a
   * SUCCESSFUL Layer 1 or Layer 2 restore, never for a skipped/deferred candidate. */
  notifyRebindDelivery(agentId: string): void
}

export type RestoreSweepSummary = {
  candidates: number
  layer1: number
  layer2: number
  layer3: number
  skippedDaemonSurvived: number
  skippedLeafHeld: number
  errors: number
  /** [S10-21a C7k, Ruling 34 Addendum 28, item 7] Every Layer-3 deferral this sweep recorded,
   * keyed by its exact audit reason code. */
  deferredByReason: Record<string, number>
}

export type RestoreOneOutcome =
  | { kind: 'layer1'; result: RebindRestoredPaneResult }
  | { kind: 'layer2'; result: RebindRestoredPaneResult }
  | { kind: 'layer3'; result?: RebindRestoredPaneResult; reasonCode: string }
  | { kind: 'skipped_daemon_survived' }
  | { kind: 'skipped_leaf_held' }
