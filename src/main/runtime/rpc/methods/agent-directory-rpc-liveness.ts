// S10-1b: RPC-layer liveness refresh + derived-row upkeep for the agent directory. Split out of
// orchestration-agents.ts to stay under the max-lines ratchet.
import type { OrcaRuntimeService } from '../../orca-runtime'
import { classifyAgentLiveness } from '../../orchestration/agent-directory'
import { sanitizeTitle } from '../../orchestration/agent-name-sanitizer'
import { deriveAgentLabelSlug } from '../../orchestration/agent-derivation'
import type { AgentRow, AgentState } from '../../orchestration/types'

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
    const sanitizedTitle = sanitizeTitle(terminal.title)
    db.upsertDerivedAgentForPane({
      hostId,
      paneKey: `${terminal.tabId}:${terminal.leafId}`,
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
