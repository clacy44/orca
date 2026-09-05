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
// [C7b, D-R110 B3] Occupancy is a LIVENESS question, answered from `findConnectedLeafOccupant`
// (this process's own connected leaves) — never from persisted layout, which survives a restart
// and made every candidate read as already-occupied. A leaf held by the pane's OWN live session
// (occupant paneKey === the row's) is `skipped_daemon_survived`, audited, no ticket. A leaf held
// by anything else proceeds to Layer 2 WITHOUT a placement offer, audited `leaf_occupied_by_other`.
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

export type RestoreSweepDeps = {
  getOrchestrationDb(): OrchestrationDb
  getOrchestrationCompatibilityHostId(): string
  getLaunchGenerationId(): string
  /** [D-R110 B3] Liveness-only occupant lookup — `orca-runtime.ts#findConnectedLeafOccupant`.
   * Distinguishes the pane's own live session from anything else on the leaf. */
  findConnectedLeafOccupant(
    leafId: string,
    connectionId?: string | null
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
  collectIncumbentEvidence(
    paneKey: string,
    ptyId: string | undefined,
    now?: number
  ): Promise<IncumbentEvidence>
  getTerminalProcessIncarnation(handle: string): string | null
  /** In-process only (INV-P-021) — see orca-runtime.ts's `mintRestoreTicket`. */
  mintRestoreTicket(payload: RestoreTicketMintArgs): RestoreTicketId
}

export type RestoreSweepSummary = {
  candidates: number
  layer1: number
  layer2: number
  layer3: number
  skippedDaemonSurvived: number
  errors: number
}

function auditSweepSkip(
  db: OrchestrationDb,
  hostId: string,
  paneKey: string,
  agentId: string,
  reasonCode: string
): void {
  db.writeAgentAudit({
    agentId,
    actorPaneKey: paneKey,
    actorHostId: hostId,
    verb: 'sweep_skip',
    outcome: 'deferred',
    reasonCode
  })
}

function auditLayer3(
  db: OrchestrationDb,
  hostId: string,
  paneKey: string,
  agentId: string,
  reasonCode: string
): void {
  db.writeAgentAudit({
    agentId,
    actorPaneKey: paneKey,
    actorHostId: hostId,
    verb: 'sweep_layer3',
    outcome: 'deferred',
    reasonCode
  })
}

export type RestoreOneOutcome =
  | { kind: 'layer1' | 'layer2'; result: RebindRestoredPaneResult }
  | { kind: 'layer3'; result?: RebindRestoredPaneResult }
  | { kind: 'skipped_daemon_survived' }

/** One sleeping registered pane's restore attempt. Exported for direct per-row testing without
 * driving the whole host enumeration. Never throws for a refusal — every non-restore path is a
 * typed, audited outcome; only a genuinely unexpected `ensureAgentSession` throw is caught by
 * the caller (`runRestoreSweep`), not here, so its message reaches the Layer-3 audit unmodified. */
export async function restoreOneRegisteredPane(
  deps: RestoreSweepDeps,
  db: OrchestrationDb,
  hostId: string,
  agentId: string,
  worktreeId: string | null,
  launchRow: AgentLaunchSessionRow
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
  // [S10-21a C7e, D-R111 R2] `findConnectedLeafOccupant` reads `this.leaves`, populated only by
  // the renderer's `syncWindowGraph` — EMPTY at the sweep's own run point (main startup, before
  // any renderer has mounted). Deciding "daemon survived" from it never fires, and the sweep
  // would mint a competing `--resume` spawn for a session the daemon is still holding, ahead of
  // the rebind's own (later) refusal. The primary decision is the pre-spawn incumbent EVIDENCE
  // (§2.5's D1/D3, collected below) — `findConnectedLeafOccupant` is now only a SECONDARY signal,
  // used to decide `leaf_occupied_by_other`/placement withholding on whatever platforms or
  // startup orderings DO have a populated leaves map by this point (never load-bearing for the
  // daemon-survived decision itself).
  const occupant = deps.findConnectedLeafOccupant(parsed.leafId)
  const predecessorPtyId =
    occupant?.ptyId ?? deps.getPersistedPtyIdForLeaf(parsed.tabId, parsed.leafId, hostId)
  // [D-R110 fix 4] Collected BEFORE the spawn, with the predecessor's own ptyId.
  const incumbentEvidence = await deps.collectIncumbentEvidence(
    launchRow.pane_key,
    predecessorPtyId
  )
  const incumbent = resolveIncumbentDeath(incumbentEvidence)
  // [S10-21a C7e, D-R111 R2; S10-21a C7g, Ruling 34 Addendum 25] The daemon-survived decision,
  // from evidence, BEFORE minting: a live D3 reading, a runtime-known D1 pty, or the daemon's
  // OWN inventory still listing this pty (D2 'present' — the pre-spawn survival signal
  // `collectIncumbentEvidence`'s controller-inventory round already proves, which `d1`/`d3`
  // alone miss at this process's own boot-time sweep run point) all mean the incumbent is
  // provably not dead — never mint a competing ticket or spawn a second `--resume` over it.
  if (
    !incumbent.dead &&
    (incumbentEvidence.d3.liveNow ||
      incumbentEvidence.d1.ptyKnownToRuntime ||
      incumbentEvidence.d2.inventory === 'present')
  ) {
    const survivalSignal = incumbentEvidence.d3.liveNow
      ? 'd3_live_now'
      : incumbentEvidence.d1.ptyKnownToRuntime
        ? 'd1_pty_known_to_runtime'
        : 'd2_inventory_present'
    auditSweepSkip(db, hostId, launchRow.pane_key, agentId, `daemon_survived: ${survivalSignal}`)
    return { kind: 'skipped_daemon_survived' }
  }
  let offerPlacement = true
  if (occupant) {
    if (occupant.paneKey === launchRow.pane_key) {
      // [S10-21a C7f/C7g fix, D-R114 fix 5 — CORRECTED] Reverting C7f's "audit-only, no return"
      // reduction: it broke two passing tests (restore-registered-agent-panes.test.ts's own
      // "leaf's own live occupant IS the row's own pane" and its D-R111 R2 case) that construct
      // evidence where `incumbent.dead` is TRUE (e.g. D1 alone) yet an occupant still names this
      // pane — a real, exercised state, not dead code as C7f's comment assumed. This branch IS a
      // second, independent decision point (a live LOCAL occupant on this leaf, whenever
      // `this.leaves` happens to be populated) and must keep its own early return.
      auditSweepSkip(db, hostId, launchRow.pane_key, agentId, 'daemon_survived')
      return { kind: 'skipped_daemon_survived' }
    }
    auditSweepSkip(db, hostId, launchRow.pane_key, agentId, 'leaf_occupied_by_other')
    offerPlacement = false
  } else if (!deps.isLeafInPersistedLayout(parsed.tabId, parsed.leafId, hostId)) {
    offerPlacement = false
  }
  const currentGeneration = deps.getLaunchGenerationId()
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
        R.worktree_id,
        launchRow
      )
      if (outcome.kind === 'layer1') {
        summary.layer1 += 1
      } else if (outcome.kind === 'layer2') {
        summary.layer2 += 1
      } else if (outcome.kind === 'skipped_daemon_survived') {
        summary.skippedDaemonSurvived += 1
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
