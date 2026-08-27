// Why: three publication points project the same cached per-pane agent status
// rows into client-facing shapes (worktree.ps agent rows, the desktop
// `agentStatus:getSnapshot` snapshot, and the per-tab `agentStatus` carried on
// mobile/paired session-tab snapshots). All three must agree on the same
// liveness join at the producer, so a row whose tab has left every session
// and the live graph, with no connected PTY, is never published as live on
// ANY surface — it stays available in last-status.json for hydration/history
// only. Extracted from `attachAgentRowsToSummaries` (STA — FIX 2) so the other
// two call sites cannot drift from the worktree.ps predicate.
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'

export type RetainedHistoryAgentRowEntry = {
  readonly paneKey: string
  readonly tabId?: string
  readonly connectionId: string | null
  readonly ptyId?: string
}

export type ConnectedPtyEvidence = {
  readonly tabIds: ReadonlySet<string>
  readonly paneKeys: ReadonlySet<string>
  readonly ptyIds: ReadonlySet<string>
}

export type RetainedHistoryAgentRowContext = {
  /** Resolves a tabId to the worktreeId it currently mirrors (session record or live graph). */
  readonly mirroredWorktreeIdByTabId: ReadonlyMap<string, string>
  /** Independent proof a pane is still live even when its tab has left every session record. */
  readonly connectedPtyEvidence: ConnectedPtyEvidence
}

/**
 * True when `entry` is retained history only: its tab left every session and
 * the live graph, no connected PTY backs it, and it is not an SSH row (whose
 * tab may exist only remotely) or one with no resolvable tabId (staleness
 * unprovable). Publishing such a row resurrects a closed agent (#6072).
 *
 * `resolvedTabId` lets callers resolve legacy/numeric pane-key encodings
 * before calling in; when omitted, `entry.tabId` is used as-is.
 */
export function isRetainedHistoryAgentRow(
  entry: RetainedHistoryAgentRowEntry,
  ctx: RetainedHistoryAgentRowContext,
  resolvedTabId: string | undefined = entry.tabId
): boolean {
  if (resolvedTabId === undefined) {
    return false
  }
  const mirroredWorktreeId = ctx.mirroredWorktreeIdByTabId.get(resolvedTabId)
  if (mirroredWorktreeId !== undefined) {
    return false
  }
  if (!(entry.connectionId === null || isWslHookRelayConnectionId(entry.connectionId))) {
    return false
  }
  if (ctx.connectedPtyEvidence.tabIds.has(resolvedTabId)) {
    return false
  }
  if (ctx.connectedPtyEvidence.paneKeys.has(entry.paneKey)) {
    return false
  }
  if (entry.ptyId !== undefined && ctx.connectedPtyEvidence.ptyIds.has(entry.ptyId)) {
    return false
  }
  return true
}
