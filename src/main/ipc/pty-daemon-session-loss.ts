// R315: handler for ptys that died WITH the daemon (announced after an authoritative inventory):
//   1. write the `daemon_died` audit rows the post-spawn respawn gate consumes;
//   2. plan recovery (pane key, peer-owned, chair verdict) while the runtime still knows the ptys;
//   3. apply main-side exit semantics WITHOUT a renderer `pty:exit` (that would close tabs);
//   4. tell the window which panes to recover, if there is one.
import type { PtySessionsLostToDaemonDeathEvent } from '../providers/types'
import type { DaemonLossRecoveryPlanEntry } from '../runtime/orchestration/daemon-loss-chair-verdict'

export type DaemonSessionsLostRendererPayload = {
  epoch: number
  sessions: { id: string; paneKey: string | null; reanchor: boolean }[]
}

export type DaemonSessionLossDeps = {
  isCurrentPtyExit: (payload: { id: string; incarnationId?: string }) => boolean
  /** Writes one `daemon_died` audit row per agent pane (daemon-init's fanout handler). */
  notifyDaemonDiedFanout: (ptyIds: readonly string[]) => void
  planRecovery: (
    sessions: readonly { id: string; incarnationId?: string }[]
  ) => Promise<DaemonLossRecoveryPlanEntry[]>
  /** The provider-exit listener's body, minus `sendPtyExitToRenderer`. */
  applyProviderPtyExitState: (payload: { id: string; code: number; incarnationId?: string }) => void
  /** Returns false when there is no usable window (nothing is sent). */
  sendToRenderer: (payload: DaemonSessionsLostRendererPayload) => boolean
  recordBreadcrumb: (name: string, data: Record<string, string | number | boolean>) => void
}

// Why: the daemon died, so the process exited abnormally; mirrors the synthetic-exit code.
const DAEMON_LOSS_EXIT_CODE = -1

export function createDaemonSessionLossHandler(
  deps: DaemonSessionLossDeps
): (event: PtySessionsLostToDaemonDeathEvent) => Promise<void> {
  return async (event) => {
    // Why: a pty id the runtime already moved to a newer incarnation was respawned by some other
    // trigger before this announcement landed; it is not a casualty any more.
    const lost = event.sessions.filter(({ id, incarnationId }) =>
      deps.isCurrentPtyExit({ id, ...(incarnationId ? { incarnationId } : {}) })
    )
    if (lost.length === 0) {
      return
    }
    try {
      deps.notifyDaemonDiedFanout(lost.map(({ id }) => id))
    } catch (error) {
      console.error('[daemon] daemon_died audit for lost sessions failed:', error)
    }
    let plan: DaemonLossRecoveryPlanEntry[] | null = null
    try {
      plan = await deps.planRecovery(lost)
    } catch (error) {
      console.error('[daemon] daemon-loss recovery plan failed:', error)
    }
    const applied: string[] = []
    for (const { id, incarnationId } of lost) {
      // Re-check after the plan's await: a concurrent respawn of the same pane id wins.
      if (!deps.isCurrentPtyExit({ id, ...(incarnationId ? { incarnationId } : {}) })) {
        continue
      }
      deps.applyProviderPtyExitState({
        id,
        code: DAEMON_LOSS_EXIT_CODE,
        ...(incarnationId ? { incarnationId } : {})
      })
      applied.push(id)
    }
    let notified = false
    if (plan) {
      const appliedIds = new Set(applied)
      const sessions = plan
        .filter((entry) => appliedIds.has(entry.id) && !entry.peerOwned)
        .map(({ id, paneKey, reanchor }) => ({ id, paneKey, reanchor }))
      if (sessions.length > 0) {
        notified = deps.sendToRenderer({ epoch: event.epoch, sessions })
      }
    }
    deps.recordBreadcrumb('daemon_sessions_lost', {
      count: lost.length,
      applied: applied.length,
      notified,
      ...(event.sinceDisconnectMs === undefined
        ? {}
        : { sinceDisconnectMs: event.sinceDisconnectMs })
    })
  }
}
