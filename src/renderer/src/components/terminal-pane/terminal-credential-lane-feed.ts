// Why a feed beside the per-pane store: the lane fields ride `terminal.list` (S9 §2k), but the
// desktop has no central roster poll (§10(d)), so the screen that renders panes owns hydrating the
// store from that boundary. This reads `terminal.list` for one runtime target on an interval and
// applies its rows through the store's per-scope reconciliation, so a pane that left the list drops
// its stale attribution rather than freezing on a chip.
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../../shared/runtime-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import {
  applyTerminalCredentialLaneRows,
  clearCredentialLaneScope,
  type TerminalCredentialLaneRow
} from '@/lib/pane-manager/terminal-credential-lane-state'
import { viewerOwnsCredentialLane } from './terminal-open-in-lane-action'

const DEFAULT_LANE_FEED_INTERVAL_MS = 15_000

/** The scope key one target's rows are reconciled under — the environment id, or the local sentinel. */
export function laneFeedScopeKey(target: RuntimeClientTarget): string {
  return target.kind === 'environment' ? `env:${target.environmentId}` : 'local'
}

/**
 * Reduce one `terminal.list` response to the store's lane rows (S9 §2h): every summary with a pty id
 * that carries a lane field. `credentialLaneOwner` is joined from the row's own self-participant, so
 * the "Open in my lane" gate can tell the viewer's lane from a peer's without a second read.
 */
export function collectTerminalCredentialLaneRows(
  summaries: readonly RuntimeTerminalSummary[]
): TerminalCredentialLaneRow[] {
  const rows: TerminalCredentialLaneRow[] = []
  for (const summary of summaries) {
    if (!summary.ptyId) {
      continue
    }
    const ownsLane = summary.presence
      ? viewerOwnsCredentialLane(summary.presence.participants)
      : false
    rows.push({
      ptyId: summary.ptyId,
      lane: {
        credentialLane: summary.credentialLane ?? 'unknown',
        ...(summary.laneState ? { laneState: summary.laneState } : {}),
        ...(summary.laneAccountLabel ? { laneAccountLabel: summary.laneAccountLabel } : {}),
        ...(summary.laneUsage ? { laneUsage: summary.laneUsage } : {}),
        ...(ownsLane ? { credentialLaneOwner: true as const } : {})
      }
    })
  }
  return rows
}

/**
 * Poll `terminal.list` for one target and keep the lane store fresh. Returns a stop that cancels the
 * interval and clears the target's scope, so a torn-down feed leaves no stale lanes behind.
 */
export function startTerminalCredentialLaneFeed(
  target: RuntimeClientTarget,
  options: { intervalMs?: number } = {}
): () => void {
  const scopeKey = laneFeedScopeKey(target)
  let active = true

  const pull = async (): Promise<void> => {
    try {
      const result = await callRuntimeRpc<RuntimeTerminalListResult>(
        target,
        'terminal.list',
        { includeVisualLayouts: false, includePresence: true, limit: 10_000 },
        { timeoutMs: 8000 }
      )
      if (active && result.truncated !== true) {
        applyTerminalCredentialLaneRows(
          scopeKey,
          collectTerminalCredentialLaneRows(result.terminals)
        )
      }
    } catch {
      // A failed read leaves the last-good rows; the next tick retries. Never blank on one miss.
    }
  }

  void pull()
  const interval = setInterval(
    () => void pull(),
    options.intervalMs ?? DEFAULT_LANE_FEED_INTERVAL_MS
  )

  return () => {
    active = false
    clearInterval(interval)
    clearCredentialLaneScope(scopeKey)
  }
}
