// S10-21a C7 (design v3.2 §2.1/§2.1a/§2.1b/§2.1c; errata 5(p) v2.1 §C.5; Ruling 34 Addenda
// 9/16/18): the main-process restore sweep. Invoked directly from main startup (index.ts) —
// NEVER `ipcMain.handle` — after the orchestration store attaches, before the window/RPC start.
// Layer 1 (same leaf, no rebind) and Layer 2 (fresh pane + C5's rebindRestoredPane) both go
// through ONE `ensureAgentSession` call per sleeping registered pane, carrying a redeemed
// restore ticket as in-process-only provenance (INV-P-021) — `createTerminal`'s own admission
// (C3a-v2/errata 5(p)) decides whether the pane key is preserved (Layer 1) or moved (Layer 2);
// this module never branches on that itself, it always calls `rebindRestoredPane` afterward,
// whose own clause 3 is a structural no-op for the Layer-1 case (§2.4). Layer 3 is "leave for
// register" — a loud audit row, never a silent skip.
//
// [JUDGMENT CALL, see RETURN] The design's §2.1 pseudocode loops over `agent_launch_sessions`
// rows first, then resolves the agents row. The brief's own SCOPE text frames the loop the other
// way ("per sleeping registered pane: mint a ticket from its newest launch row … skip panes with
// no row → Layer 3, audit 'sweep_no_launch_row'") — which is the only framing that can ever
// reach that specific Layer-3 case, since a registered pane with NO launch row never appears in
// the launch-rows enumeration at all. This module iterates registered rows (via `db.listAgents`)
// and looks up each one's newest launch row, reconciling the two: every row the §2.1 pseudocode
// would visit is still visited (it has a launch row by definition), and the brief's
// no-launch-row case is now reachable.
//
// [JUDGMENT CALL, see RETURN] "if a live pty already occupies row.pane_key: continue (daemon
// survived)" (§2.1) is implemented as: the pane's own leaf already reads live/stable
// (`leafHoldsLiveOrStablePane`) — skipped with NO ticket minted and no audit row (this is the
// ordinary "nothing to do" case, not a refusal). §2.1b's OWN occupied-leaf refusal (mint a fresh
// pane, no placement) therefore never actually fires from this loop as written — an occupied
// leaf here always means "this exact pane is still alive," which is the daemon-survived
// shortcut, not a competing occupant. A future slice that can distinguish "the leaf is occupied
// by something OTHER than this row's own pane" would restore §2.1b's fresh-pane branch; nothing
// in this loop can currently tell the two apart from a boolean occupancy check alone.
import type { AgentLaunchSessionRow } from '../runtime/orchestration/agent-launch-sessions'
import type { RebindRestoredPaneResult } from '../runtime/orchestration/agent-restore-rebind'
import { resolveIncumbentDeath, type IncumbentEvidence } from '../runtime/incumbent-death'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type {
  RuntimeAgentSessionRpcCaller,
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../shared/agent-session-host-authority'
import type { ResumableTuiAgent } from '../../shared/agent-session-resume'
import type { RestoreTicketId, RestoreTicketMintArgs } from '../runtime/restore-ticket-registry'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { acquireRestoreSweepLock, releaseRestoreSweepLock } from '../runtime/restore-sweep-lock'

export type RestoreSweepDeps = {
  getOrchestrationDb(): OrchestrationDb
  getOrchestrationCompatibilityHostId(): string
  getLaunchGenerationId(): string
  leafHoldsLiveOrStablePane(leafId: string, connectionId?: string | null): boolean
  ensureAgentSession(
    request: RuntimeEnsureAgentSessionRequest,
    caller: RuntimeAgentSessionRpcCaller,
    internal: { restoreProvenance: { kind: 'host-restore'; ticket: RestoreTicketId } }
  ): Promise<RuntimeEnsureAgentSessionResult>
  collectIncumbentEvidence(
    paneKey: string,
    ptyId: string | undefined,
    now?: number
  ): Promise<IncumbentEvidence>
  getTerminalProcessIncarnation(handle: string): string | null
  /** In-process only (INV-P-021) — backed by the runtime's own `RestoreTicketRegistry`
   * instance, the same one `createTerminal`'s E1 redeems against. This module imports only the
   * TYPES from `restore-ticket-registry.ts` (erased at compile time) — the registry instance
   * and its `mint` call stay inside `orca-runtime.ts`, which is where INV-P-021's "minted only
   * in-process" property is actually enforced (the import-boundary test scans forbidden roots
   * for ANY specifier resolving to that module, `src/main/startup/**` is not one of them, and no
   * VALUE import of it appears here regardless). */
  mintRestoreTicket(payload: RestoreTicketMintArgs): RestoreTicketId
}

export type RestoreSweepSummary = {
  candidates: number
  layer1: number
  layer2: number
  layer3: number
  skippedAlreadyLive: number
  errors: number
}

function auditNoLaunchRow(
  db: OrchestrationDb,
  hostId: string,
  paneKey: string,
  agentId: string
): void {
  db.writeAgentAudit({
    agentId,
    actorPaneKey: paneKey,
    actorHostId: hostId,
    verb: 'sweep_layer3',
    outcome: 'deferred',
    reasonCode: 'sweep_no_launch_row'
  })
}

function auditLayer3Refused(
  db: OrchestrationDb,
  hostId: string,
  paneKey: string,
  agentId: string,
  reason: string
): void {
  db.writeAgentAudit({
    agentId,
    actorPaneKey: paneKey,
    actorHostId: hostId,
    verb: 'sweep_layer3',
    outcome: 'deferred',
    reasonCode: `sweep_restore_failed: ${reason}`
  })
}

/** One sleeping registered pane's restore attempt — Layer 1/2 via `ensureAgentSession` +
 * `rebindRestoredPane`, Layer 3 (audited, no throw) on any refusal. Exported for direct
 * per-row testing (T1/T21/T24/T25) without driving the whole host enumeration. */
export async function restoreOneRegisteredPane(
  deps: RestoreSweepDeps,
  db: OrchestrationDb,
  hostId: string,
  agentId: string,
  worktreeId: string | null,
  launchRow: AgentLaunchSessionRow
): Promise<{ layer: 1 | 2 | 3; result?: RebindRestoredPaneResult }> {
  const parsed = parsePaneKey(launchRow.pane_key)
  if (!parsed || !worktreeId) {
    auditLayer3Refused(db, hostId, launchRow.pane_key, agentId, 'unparseable_pane_or_no_worktree')
    return { layer: 3 }
  }
  // §2.1: "if a live pty already occupies row.pane_key: continue (daemon survived)" — see the
  // file-header JUDGMENT CALL. No ticket, no audit: there is nothing wrong here to record.
  if (deps.leafHoldsLiveOrStablePane(parsed.leafId)) {
    return { layer: 1 }
  }
  const ticket = deps.mintRestoreTicket({
    predecessorPaneKey: launchRow.pane_key,
    sessionId: launchRow.session_id,
    executionHostId: launchRow.execution_host_id,
    launchGeneration: launchRow.launch_generation,
    launchSeq: launchRow.seq
  })
  let created: RuntimeEnsureAgentSessionResult
  try {
    created = await deps.ensureAgentSession(
      {
        kind: 'explicit',
        worktree: `id:${worktreeId}`,
        agent: launchRow.agent_type as ResumableTuiAgent,
        providerSession: { key: 'session_id', id: launchRow.session_id },
        presentation: 'background',
        placement: { tabId: parsed.tabId, leafId: parsed.leafId }
      },
      {},
      { restoreProvenance: { kind: 'host-restore', ticket } }
    )
  } catch (err) {
    auditLayer3Refused(
      db,
      hostId,
      launchRow.pane_key,
      agentId,
      err instanceof Error ? err.message : String(err)
    )
    return { layer: 3 }
  }
  const newPaneKey = created.terminal.paneKey ?? launchRow.pane_key
  const newTerminalHandle = created.terminal.handle
  const incumbentEvidence = await deps.collectIncumbentEvidence(launchRow.pane_key, undefined)
  const incumbent = resolveIncumbentDeath(incumbentEvidence)
  const result = db.rebindRestoredPane({
    ticketPayload: {
      predecessorPaneKey: launchRow.pane_key,
      sessionId: launchRow.session_id,
      executionHostId: launchRow.execution_host_id,
      launchGeneration: launchRow.launch_generation,
      launchSeq: launchRow.seq
    },
    newPaneKey,
    newTerminalHandle,
    hostId,
    executionHostId: created.terminal.executionHostId ?? launchRow.execution_host_id,
    launchGeneration: deps.getLaunchGenerationId(),
    incumbent,
    processIncarnation: deps.getTerminalProcessIncarnation(newTerminalHandle)
  })
  if (!result.ok) {
    auditLayer3Refused(db, hostId, launchRow.pane_key, agentId, result.reason)
    return { layer: 3, result }
  }
  // §2.1c "the marks … written in the same synchronous step that redeems a row, before the
  // lock releases" — this call happens while the sweep's own lock (below) is still held.
  db.setSweepRestoreMark(hostId, launchRow.pane_key)
  return { layer: result.rebound ? 2 : 1, result }
}

/** The sweep itself: acquires the lock, enumerates every sleeping registered pane for this
 * host, restores each (Layer 1/2) or defers it (Layer 3, audited), releases the lock. Never
 * throws for a single pane's failure — every failure is Layer 3, loud, per-pane. A throw from
 * enumeration itself (no db, e.g.) propagates — startup should see that, not swallow it. */
export async function runRestoreSweep(deps: RestoreSweepDeps): Promise<RestoreSweepSummary> {
  const summary: RestoreSweepSummary = {
    candidates: 0,
    layer1: 0,
    layer2: 0,
    layer3: 0,
    skippedAlreadyLive: 0,
    errors: 0
  }
  const db = deps.getOrchestrationDb()
  const hostId = deps.getOrchestrationCompatibilityHostId()
  acquireRestoreSweepLock()
  try {
    // [JUDGMENT CALL, see RETURN] `listAgents`'s own `limit` caps at 200 — the sweep needs every
    // registered row, not a UI page, so the max is requested explicitly rather than trusting the
    // default (100). A host with more than 200 registered, non-derived, non-quarantined panes
    // would still truncate here; unraised because no fleet at this scale exists yet, but it is a
    // real ceiling this commit does not lift.
    const registered = db
      .listAgents({ hostId, limit: 200 })
      .agents.filter((a) => a.derived === 0 && a.quarantined === 0 && a.pane_key !== null)
    for (const R of registered) {
      const paneKey = R.pane_key as string
      const parsed = parsePaneKey(paneKey)
      if (parsed && deps.leafHoldsLiveOrStablePane(parsed.leafId)) {
        summary.skippedAlreadyLive += 1
        continue
      }
      summary.candidates += 1
      const launchRow = db.newestLaunchForPane(hostId, paneKey)
      if (!launchRow) {
        auditNoLaunchRow(db, hostId, paneKey, R.id)
        summary.layer3 += 1
        continue
      }
      try {
        const outcome = await restoreOneRegisteredPane(
          deps,
          db,
          hostId,
          R.id,
          R.worktree_id,
          launchRow
        )
        if (outcome.layer === 1) {
          summary.layer1 += 1
        } else if (outcome.layer === 2) {
          summary.layer2 += 1
        } else {
          summary.layer3 += 1
        }
      } catch (err) {
        summary.errors += 1
        auditLayer3Refused(
          db,
          hostId,
          paneKey,
          R.id,
          err instanceof Error ? err.message : String(err)
        )
      }
    }
  } finally {
    releaseRestoreSweepLock()
  }
  return summary
}
