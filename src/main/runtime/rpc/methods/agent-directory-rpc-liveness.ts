// S10-1b: RPC-layer liveness refresh + derived-row upkeep for the agent directory. Split out of
// orchestration-agents.ts to stay under the max-lines ratchet.
import type { OrcaRuntimeService } from '../../orca-runtime'
import { classifyAgentLiveness } from '../../orchestration/agent-liveness-classification'
import { sanitizeTitle } from '../../orchestration/agent-name-sanitizer'
import { deriveAgentLabelSlug } from '../../orchestration/agent-derivation'
import type { AgentRow, AgentState } from '../../orchestration/types'
import { wakePactThreadBoth } from './orchestration-pact-wake'
import { isRestoreSweepLockHeld } from '../../restore-sweep-lock'

// [S10-21a C8] Throttle for the 'derived_mint_deferred' audit below — in-process, not
// persisted: a rate-limit for hygiene, not evidence that must survive a restart.
const DERIVED_MINT_DEFERRED_AUDIT_INTERVAL_MS = 60 * 60 * 1000
const lastDerivedMintDeferredAuditAt = new Map<string, number>()

/** [S10-21a C8, design v3.2 §2.8] True while directory derivation must yield to the restore
 * sweep for this pane, returning the reason code for the audit — checked ONLY before minting a
 * fresh derived row (a registered row already occupying the pane is untouched regardless, per
 * `upsertDerivedAgentForPane`'s own fence, so this never affects an ordinary already-registered
 * pane). Three signals, any one sufficient: (a) the sweep's own lock is held — the whole sweep
 * pass is mid-flight; (b) an unredeemed restore ticket names this pane as its predecessor — the
 * sweep has started this pane's own restore and the create/redeem step has not landed yet; (c)
 * this generation's sweep already wrote this pane's launch row (`evidence: 'sweep_record'`) but
 * has not yet rebound an agent onto it — the gap between `createTerminal`'s launch-table write
 * and `rebindRestoredPane`'s `setLaunchAgentId`. An ordinary (non-restore) pane's launch row is
 * always `evidence: 'host_launch'`, so (c) never trips for it — the T10 fence. */
function paneAwaitingSweepRestore(
  runtime: OrcaRuntimeService,
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>,
  hostId: string,
  paneKey: string
): string | false {
  if (isRestoreSweepLockHeld()) {
    return 'sweep_lock_held'
  }
  if (runtime.hasLiveTicketForPane(paneKey)) {
    return 'live_restore_ticket'
  }
  const launch = db.newestLaunchForPane(hostId, paneKey)
  if (
    launch &&
    launch.launch_generation === runtime.getLaunchGenerationId() &&
    launch.evidence === 'sweep_record' &&
    launch.agent_id === null
  ) {
    return 'sweep_record_pending_rebind'
  }
  return false
}

function auditDerivedMintDeferredOncePerHour(
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>,
  hostId: string,
  paneKey: string,
  reasonCode: string
): void {
  const key = `${hostId}:${paneKey}`
  const now = Date.now()
  const last = lastDerivedMintDeferredAuditAt.get(key)
  if (last !== undefined && now - last < DERIVED_MINT_DEFERRED_AUDIT_INTERVAL_MS) {
    return
  }
  lastDerivedMintDeferredAuditAt.set(key, now)
  db.writeAgentAudit({
    agentId: null,
    actorPaneKey: paneKey,
    actorHostId: hostId,
    verb: 'derived_mint_deferred',
    outcome: 'deferred',
    reasonCode
  })
}

export async function findLiveTerminalByHandle(
  runtime: OrcaRuntimeService,
  handle: string | null
): Promise<{
  worktreeId: string | null
  worktreePath: string | null
  branch: string | null
  title: string | null
} | null> {
  if (!handle) {
    return null
  }
  const { terminals } = await runtime.listTerminals(undefined, undefined, {})
  const match = terminals.find((t) => t.handle === handle)
  if (!match) {
    return null
  }
  return {
    worktreeId: match.worktreeId,
    worktreePath: match.worktreePath,
    branch: match.branch,
    title: match.title
  }
}

type LivenessResult = {
  state: AgentState
  pushable: boolean
  terminalHandle: string | null
  processIncarnation: string | null
}

function resolveLiveness(runtime: OrcaRuntimeService, row: AgentRow): LivenessResult {
  if (!row.pane_key) {
    return {
      state: row.state,
      pushable: false,
      terminalHandle: row.terminal_handle,
      processIncarnation: row.process_incarnation
    }
  }
  const signals = runtime.getAgentDirectoryLivenessSignals(row.pane_key)
  const classified = classifyAgentLiveness({
    paneResolves: signals.terminalHandle !== null,
    lastAgentStatus: signals.lastAgentStatus,
    observedLive: signals.observedLive,
    lastSeenAt: row.last_seen_at,
    now: new Date().toISOString()
  })
  return {
    state: classified.state,
    pushable: classified.pushable,
    terminalHandle: signals.terminalHandle,
    processIncarnation: row.process_incarnation
  }
}

/** Liveness is observed, never claimed (CONTAINMENT): computed here and written back only when
 * it actually changed, mirroring the exact predicate the ambient-push gate uses. */
export function refreshLiveness(
  runtime: OrcaRuntimeService,
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>,
  row: AgentRow
): { row: AgentRow; pushable: boolean } {
  const liveness = resolveLiveness(runtime, row)
  if (liveness.state === row.state && liveness.terminalHandle === row.terminal_handle) {
    return { row, pushable: liveness.pushable }
  }
  const updated = db.refreshAgentLiveness({
    id: row.id,
    state: liveness.state,
    terminalHandle: liveness.terminalHandle,
    processIncarnation: liveness.processIncarnation
  })
  // Liveness § (K6): S10-2 only detected 'gone'; S10-3 acts on a fresh transition into it —
  // auto-pause every engaged pact this agent is party to and wake the counterpart immediately,
  // far inside the 30-minute clamp, instead of leaving a silent park.
  if (liveness.state === 'gone' && row.state !== 'gone') {
    for (const outcome of db.autoPausePactsForAgent(row.id, 'counterpart_gone')) {
      wakePactThreadBoth(
        runtime,
        outcome.threadId,
        [outcome.proposerAgentId, outcome.withAgentId],
        'paused',
        [`orca agents pact --release --on ${outcome.threadId}`]
      )
    }
  }
  return { row: updated, pushable: liveness.pushable }
}

/** Refreshes (or mints) a derived row per live pane, then prunes stale ones — "list"/"find"
 * both call this before reading so a live pane always shows up (CONTAINMENT #6). */
export async function refreshDerivedAgentsFromLiveGraph(
  runtime: OrcaRuntimeService,
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>,
  hostId: string
): Promise<void> {
  const { terminals } = await runtime.listTerminals(undefined, undefined, {})
  for (const terminal of terminals) {
    const paneKey = `${terminal.tabId}:${terminal.leafId}`
    // [S10-21a C8, design v3.2 §2.8] Mint ordering: yield to the restore sweep rather than
    // racing it for a pane it is mid-restore on — see `paneAwaitingSweepRestore`.
    const deferReason = paneAwaitingSweepRestore(runtime, db, hostId, paneKey)
    if (deferReason) {
      auditDerivedMintDeferredOncePerHour(db, hostId, paneKey, deferReason)
      continue
    }
    const sanitizedTitle = sanitizeTitle(terminal.title)
    db.upsertDerivedAgentForPane({
      hostId,
      paneKey,
      terminalHandle: terminal.handle,
      processIncarnation: runtime.getTerminalProcessIncarnation(terminal.handle),
      worktreeId: terminal.worktreeId,
      worktreePath: terminal.worktreePath,
      branch: terminal.branch,
      title: sanitizedTitle?.value ?? null,
      agentLabel: deriveAgentLabelSlug(terminal.title)
    })
  }
  db.pruneStaleDerivedAgents(hostId)
}
