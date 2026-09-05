// S10-21a C7/C7b (design v3.2 §2.1/§2.1a/§2.1b/§2.1c; errata 5(p) v2.1 §C.5; Ruling 34 Addenda
// 9/16/18/22; D-R110 fix list 1/3/4/6): the main-process restore sweep. Invoked directly from
// main startup (index.ts) — NEVER `ipcMain.handle` — after the store attaches and the pty
// controller exists, before RPC start. Layer 1 (same leaf, no rebind) and Layer 2 (fresh pane +
// C5's rebindRestoredPane) both go through ONE `ensureAgentSession` call per sleeping registered
// pane, carrying a redeemed restore ticket as in-process-only provenance (INV-P-021) —
// `createTerminal`'s own admission (C3a-v2/errata 5(p)) decides whether the pane key is
// preserved or moved; this module never branches on Layer 1 vs 2 itself, it always calls
// `rebindRestoredPane` afterward, whose own clause 3 is a structural no-op for the Layer-1 case.
//
// [C7b, D-R110 B1] The ticket's `launchGeneration` is THIS process's current generation
// (`deps.getLaunchGenerationId()`), never the launch row's own (possibly prior-process)
// generation — the row's generation says when that fact was first written; the ticket's says
// which runtime minted it, and `rebindRestoredPane`'s clause 1 compares the ticket's against the
// CURRENT generation it is being redeemed in. Using the row's stale value refused every rebind.
//
// [C7i, Ruling 34 Addendum 27; D-R116 REJECT of C7h, design by D-R117] Survival (rows 1-4) is
// the agent's OWN process identity (`agents.process_incarnation`) joined against ONE
// controller-inventory round the whole sweep takes (`deps.takeControllerInventoryForSweep`,
// called once by `runRestoreSweepBody`, never per-candidate) — `agentAlive`
// (agent-process-identity.ts). Leaf-observed agent status (the old D3) is no longer read for
// survival at all. When the round is unavailable, or the agent's own pty is listed without an
// identity, the pane is deferred loudly (Layer 3), never restored over and never read as dead.
// A launch admitted THIS generation (rows 5-6) still holds the leaf. Otherwise (rows 8-11) an
// own-pane occupant is judged by `ptyState` of ITS OWN ptyId over the SAME shared round — live
// (row 11) is never yielded to and never spawned over (the agent restores into a fresh pane, no
// placement); absent (row 10) is a stale surface, restored over with placement. D1/D2/D3 (the
// old survival signals) stay only in the ticket's `incumbent` evidence field and the row-10
// stale-signal audit, never a survival arm (row 7, self-resume watermark, is C7j — not here).
//
// [C7b, D-R110 fix 6] A free leaf still withholds placement when the persisted layout tree no
// longer resolves it (`isLeafInPersistedLayout`) — a closed tab's row must not resurrect into a
// leaf the current layout does not contain.
//
// [C7b, Addendum 22(v)] Before minting, if the pane's newest admission audit (any generation) is
// UNRECORDED and at least as new as the row's own `recorded_at`, the row is superseded — Layer 3,
// audited, never resumed over a newer unrecorded conversation.
import type { AgentLaunchSessionRow } from '../runtime/orchestration/agent-launch-sessions'
import type { RebindRestoredPaneResult } from '../runtime/orchestration/agent-restore-rebind'
import { resolveIncumbentDeath, type IncumbentEvidence } from '../runtime/incumbent-death'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type {
  RuntimeAgentSessionRpcCaller,
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../shared/agent-session-host-authority'
import type { ResumableTuiAgent } from '../../shared/agent-session-resume'
import type { RestoreTicketId, RestoreTicketMintArgs } from '../runtime/restore-ticket-registry'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { acquireRestoreSweepLock, releaseRestoreSweepLock } from '../runtime/restore-sweep-lock'
import type { ControllerInventory } from '../runtime/orchestration/agent-process-identity'
import {
  decideEarlyRows,
  routeDeadCandidate
} from '../runtime/orchestration/restore-sweep-decision'
import { noteSelfResumeWatermarkAbsent, evaluateRow7 } from './restore-sweep-row7-watermark'
import {
  auditSweepSkip,
  auditLayer3,
  auditSweepNote
} from '../runtime/orchestration/restore-sweep-audit'

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
}

export type RestoreOneOutcome =
  | { kind: 'layer1' | 'layer2'; result: RebindRestoredPaneResult }
  | { kind: 'layer3'; result?: RebindRestoredPaneResult }
  | { kind: 'skipped_daemon_survived' }
  | { kind: 'skipped_leaf_held' }

/** One sleeping registered pane's restore attempt. Exported for direct per-row testing without
 * driving the whole host enumeration. Never throws for a refusal — every non-restore path is a
 * typed, audited outcome; only a genuinely unexpected `ensureAgentSession` throw is caught by
 * the caller (`runRestoreSweep`), not here, so its message reaches the Layer-3 audit unmodified. */
export async function restoreOneRegisteredPane(
  deps: RestoreSweepDeps,
  db: OrchestrationDb,
  hostId: string,
  agentId: string,
  processIncarnation: string | null,
  worktreeId: string | null,
  launchRow: AgentLaunchSessionRow,
  inventory: ControllerInventory | null,
  // [C7j, forced deviation — see RETURN] Optional, defaulting to null (row 7 simply never
  // fires), so the pre-existing rows 1-11 call sites (which predate row 7) do not all need a
  // mechanical arg-count edit for an unrelated row.
  selfResumeWatermark: number | null = null
): Promise<RestoreOneOutcome> {
  const parsed = parsePaneKey(launchRow.pane_key)
  if (!parsed || !worktreeId) {
    auditLayer3(
      db,
      hostId,
      launchRow.pane_key,
      agentId,
      'sweep_no_placement: unparseable_pane_or_no_worktree'
    )
    return { kind: 'layer3' }
  }
  // [S10-21a C7c, D-R110 finding 14] `findConnectedLeafOccupant` reads only this process's OWN
  // local `leaves` map — it has no per-leaf connection scoping yet, so a remote (SSH) pane's
  // liveness cannot be answered honestly by it. Excluded outright, audited, rather than
  // evaluated against a local-only signal that could read "no occupant" for a pane that is very
  // much alive on its own execution host.
  if (launchRow.execution_host_id !== LOCAL_EXECUTION_HOST_ID) {
    auditLayer3(db, hostId, launchRow.pane_key, agentId, 'sweep_remote_pane_excluded')
    return { kind: 'layer3' }
  }
  const unrecorded = db.isNewestAdmissionUnrecordedAndNewer(
    launchRow.pane_key,
    launchRow.recorded_at
  )
  if (unrecorded.unrecorded) {
    auditLayer3(
      db,
      hostId,
      launchRow.pane_key,
      agentId,
      `unrecorded_launch: ${unrecorded.reasonCode}`
    )
    return { kind: 'layer3' }
  }
  // [C7i, Ruling 34 Addendum 27] Rows 1-6 — pure, see restore-sweep-decision.ts.
  const currentGeneration = deps.getLaunchGenerationId()
  const early = decideEarlyRows(
    processIncarnation,
    inventory,
    launchRow.launch_generation,
    currentGeneration,
    launchRow.evidence,
    launchRow.seq
  )
  if (early.kind === 'skipped_daemon_survived') {
    auditSweepSkip(db, hostId, launchRow.pane_key, agentId, early.reasonCode)
    return { kind: 'skipped_daemon_survived' }
  }
  if (early.kind === 'layer3') {
    auditLayer3(db, hostId, launchRow.pane_key, agentId, early.reasonCode)
    return { kind: 'layer3' }
  }
  if (early.kind === 'skipped_leaf_held') {
    auditSweepSkip(db, hostId, launchRow.pane_key, agentId, early.reasonCode)
    return { kind: 'skipped_leaf_held' }
  }
  if (early.noteReasonCode) {
    auditSweepNote(db, hostId, launchRow.pane_key, agentId, early.noteReasonCode)
  }

  // [C7j, Ruling 34 Addendum 27 row 7] Evaluated after rows 5-6 (above) and before rows 8-11
  // (below) — see restore-sweep-row7-watermark.ts's own doc comment.
  if (evaluateRow7(db, hostId, agentId, launchRow, selfResumeWatermark) === 'skipped_leaf_held') {
    return { kind: 'skipped_leaf_held' }
  }

  // [C7e/C7h, D-R111 R2, Addendum 26] `this.leaves` occupancy is a RACE at this run point, not
  // an invariant. [C7i, Ruling 34 Addendum 27] The evidence pty for `collectIncumbentEvidence`
  // prefers the agent's OWN identity, then the row's persisted ptyId, then the occupant's —
  // D1/D2/D3 stay in the ticket's evidence field and the row-10 stale-signal audit only, never a
  // survival arm; rows 8-11 (restore-sweep-decision.ts) judge the OCCUPANT's own ptyId via
  // `ptyState`, over the same shared round, regardless of which ptyId this evidence was
  // collected for.
  const occupant = deps.findConnectedLeafOccupant(parsed.leafId, parsed.tabId)
  const rowPtyId = deps.getPersistedPtyIdForLeaf(parsed.tabId, parsed.leafId, hostId)
  const evidencePtyId = early.identity?.ptyId ?? rowPtyId ?? occupant?.ptyId
  const incumbentEvidence = await deps.collectIncumbentEvidence(
    launchRow.pane_key,
    evidencePtyId,
    undefined,
    inventory
  )
  const incumbent = resolveIncumbentDeath(incumbentEvidence)
  const routing = routeDeadCandidate(
    occupant,
    launchRow.pane_key,
    occupant ? incumbentEvidence.ptyState?.(occupant.ptyId) : undefined,
    deps.isLeafInPersistedLayout(parsed.tabId, parsed.leafId, hostId)
  )
  const offerPlacement = routing.offerPlacement
  if (routing.audit) {
    const write = routing.audit.verb === 'sweep_skip' ? auditSweepSkip : auditSweepNote
    write(db, hostId, launchRow.pane_key, agentId, routing.audit.reasonCode)
  }
  const ticket = deps.mintRestoreTicket({
    predecessorPaneKey: launchRow.pane_key,
    sessionId: launchRow.session_id,
    executionHostId: launchRow.execution_host_id,
    launchGeneration: currentGeneration,
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
        placement: offerPlacement ? { tabId: parsed.tabId, leafId: parsed.leafId } : undefined
      },
      {},
      { restoreProvenance: { kind: 'host-restore', ticket } }
    )
  } catch (err) {
    auditLayer3(
      db,
      hostId,
      launchRow.pane_key,
      agentId,
      `ensure_agent_session_failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return { kind: 'layer3' }
  }
  const newPaneKey = created.terminal.paneKey ?? launchRow.pane_key
  const newTerminalHandle = created.terminal.handle
  const result = db.rebindRestoredPane({
    ticketPayload: {
      predecessorPaneKey: launchRow.pane_key,
      sessionId: launchRow.session_id,
      executionHostId: launchRow.execution_host_id,
      launchGeneration: currentGeneration,
      launchSeq: launchRow.seq
    },
    newPaneKey,
    newTerminalHandle,
    hostId,
    executionHostId: created.terminal.executionHostId ?? launchRow.execution_host_id,
    launchGeneration: currentGeneration,
    incumbent,
    processIncarnation: deps.getTerminalProcessIncarnation(newTerminalHandle)
  })
  if (!result.ok) {
    auditLayer3(db, hostId, launchRow.pane_key, agentId, `rebind_refused: ${result.reason}`)
    return { kind: 'layer3', result }
  }
  // §2.1c "the marks … written in the same synchronous step that redeems a row, before the
  // lock releases" — this call happens while the sweep's own lock is still held.
  db.setSweepRestoreMark(hostId, launchRow.pane_key)
  // [S10-21a C9 hand-off, D-I80] Arms any mail already waiting on `agent:<id>` — one call, only
  // after a SUCCESSFUL restore, never for a skipped/deferred candidate.
  deps.notifyRebindDelivery(agentId)
  return { kind: result.rebound ? 'layer2' : 'layer1', result }
}

/** [S10-21a C7b, D-R110 B2, Ruling 34 Addendum 22] The sweep's BODY — enumerates every
 * registered pane with a launch row for this host, restores each (Layer 1/2), defers it
 * (Layer 3, audited), or records it already alive (`skipped_daemon_survived`, audited). Does
 * NOT acquire or release the lock itself: the desktop startup path must hold the lock across
 * "open the window, await the startup barriers, THEN run the sweep" (B2's fix — the window has
 * to open first so the pty controller exists), which spans more than this function's own call.
 * `runRestoreSweep` below is the lock-owning convenience wrapper for callers (the serve path)
 * that have no such ordering constraint. A single pane's unexpected throw is caught and
 * downgraded to a Layer-3 audit; it never aborts the rest. */
export async function runRestoreSweepBody(deps: RestoreSweepDeps): Promise<RestoreSweepSummary> {
  const summary: RestoreSweepSummary = {
    candidates: 0,
    layer1: 0,
    layer2: 0,
    layer3: 0,
    skippedDaemonSurvived: 0,
    skippedLeafHeld: 0,
    errors: 0
  }
  const db = deps.getOrchestrationDb()
  const hostId = deps.getOrchestrationCompatibilityHostId()
  // [D-R110 finding 9] `includeDerived: false` explicit — `listAgents`'s own default INCLUDES
  // derived rows in its 200-row window (registered_at ASC, sliced before this filter), so a
  // recent chair could fall outside it under load; asking for non-derived only up front keeps
  // the 200-row cap scoped to the population the sweep actually cares about.
  const registered = db
    .listAgents({ hostId, includeDerived: false, limit: 200 })
    .agents.filter((a) => a.quarantined === 0 && a.pane_key !== null)
  // [C7i, Ruling 34 Addendum 27] ONE controller-inventory round for the WHOLE sweep — every
  // candidate below is judged from this same round, never a per-candidate one.
  const inventory = await deps.takeControllerInventoryForSweep()
  // [C7j, Ruling 34 Addendum 27 row 7] ONE watermark for the WHOLE sweep, same shape as
  // `inventory` above. Absent (DB not attached at the capture point, before openMainWindow)
  // means row 7 never fires this sweep — recorded ONCE, sweep-level (no single candidate pane
  // "caused" the absence), not per-candidate.
  const selfResumeWatermark = deps.getSelfResumeWatermark()
  if (selfResumeWatermark === null) {
    noteSelfResumeWatermarkAbsent(db, hostId)
  }
  for (const R of registered) {
    const paneKey = R.pane_key as string
    const launchRow = db.newestLaunchForPane(hostId, paneKey)
    if (!launchRow) {
      auditLayer3(db, hostId, paneKey, R.id, 'sweep_no_launch_row')
      summary.layer3 += 1
      continue
    }
    summary.candidates += 1
    try {
      const outcome = await restoreOneRegisteredPane(
        deps,
        db,
        hostId,
        R.id,
        R.process_incarnation,
        R.worktree_id,
        launchRow,
        inventory,
        selfResumeWatermark
      )
      if (outcome.kind === 'layer1') {
        summary.layer1 += 1
      } else if (outcome.kind === 'layer2') {
        summary.layer2 += 1
      } else if (outcome.kind === 'skipped_daemon_survived') {
        summary.skippedDaemonSurvived += 1
      } else if (outcome.kind === 'skipped_leaf_held') {
        summary.skippedLeafHeld += 1
      } else {
        summary.layer3 += 1
      }
    } catch (err) {
      summary.errors += 1
      auditLayer3(
        db,
        hostId,
        paneKey,
        R.id,
        `sweep_row_threw: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return summary
}

/** Lock-owning convenience wrapper around `runRestoreSweepBody` — acquires before, releases
 * (in `finally`) after. Used by callers with no window/barrier ordering constraint (the serve
 * startup path); the desktop path calls `runRestoreSweepBody` directly, inside its own
 * acquire/release that also spans opening the window and awaiting the startup barriers. */
export async function runRestoreSweep(deps: RestoreSweepDeps): Promise<RestoreSweepSummary> {
  acquireRestoreSweepLock()
  try {
    return await runRestoreSweepBody(deps)
  } finally {
    releaseRestoreSweepLock()
  }
}
