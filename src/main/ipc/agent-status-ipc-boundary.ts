import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { isRetainedHistoryAgentRow } from '../agent-hooks/retained-history-agent-row'

export type AgentStatusRuntimeEnrichment = Pick<
  OrcaRuntimeService,
  | 'getAgentStatusTerminalHandleForPaneKey'
  | 'getAgentStatusOrchestrationContextForPaneKey'
  | 'buildRetainedHistoryAgentRowContext'
>

const MAX_AGENT_STATUS_DROP_TAB_ID_LENGTH = 160

export function enrichAgentStatusIpcPayload(
  data: AgentStatusIpcPayload,
  runtime: AgentStatusRuntimeEnrichment | undefined
): AgentStatusIpcPayload {
  if (!runtime) {
    return data
  }
  const terminalHandle = runtime.getAgentStatusTerminalHandleForPaneKey(data.paneKey)
  const orchestration = runtime.getAgentStatusOrchestrationContextForPaneKey(data.paneKey)
  return {
    ...data,
    ...(terminalHandle ? { terminalHandle } : {}),
    ...(orchestration ? { orchestration } : {})
  }
}

/** Drops rows whose tab left every session and the live graph, with no
 * connected PTY (FIX 2) — same predicate `attachAgentRowsToSummaries` applies
 * for worktree.ps, so `agentStatus:getSnapshot` cannot show a ghost agent row. */
export function filterRetainedHistoryAgentStatusRows(
  rows: readonly AgentStatusIpcPayload[],
  runtime: AgentStatusRuntimeEnrichment | undefined
): AgentStatusIpcPayload[] {
  if (!runtime) {
    return [...rows]
  }
  const ctx = runtime.buildRetainedHistoryAgentRowContext()
  return rows.filter((row) => {
    const tabId =
      row.tabId ?? parsePaneKey(row.paneKey)?.tabId ?? parseLegacyNumericPaneKey(row.paneKey)?.tabId
    return !isRetainedHistoryAgentRow(
      { paneKey: row.paneKey, tabId, connectionId: row.connectionId },
      ctx,
      tabId
    )
  })
}

export function isValidAgentStatusDropTabId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_AGENT_STATUS_DROP_TAB_ID_LENGTH &&
    value.trim() === value &&
    isValidTerminalTabId(value)
  )
}
