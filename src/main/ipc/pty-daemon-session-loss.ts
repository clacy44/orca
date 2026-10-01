// R315: handler for ptys that died WITH the daemon (announced after an authoritative inventory):
//   1. write the `daemon_died` audit rows the post-spawn respawn gate consumes;
//   2. plan recovery (pane key, peer-owned, chair verdict) while the runtime still knows the ptys;
//   3. tell the window which panes to recover (it captures records while their live status exists);
//   4. apply main-side exit semantics WITHOUT a renderer `pty:exit` (that would close tabs).
// Steps 3 and 4 run in one synchronous block so the relaunch can never see an unretired anchor.
import type { PtySessionsLostToDaemonDeathEvent } from '../providers/types'
import type { DaemonLossRecoveryPlanEntry } from '../runtime/orchestration/daemon-loss-chair-verdict'

export type DaemonSessionsLostRendererPayload = {
  epoch: number
  sessions: { id: string; paneKey: string | null; reanchor: boolean }[]
}

export type DaemonSessionLossDeps = {
  isCurrentPtyExit: (payload: { id: string; incarnationId?: string }) => boolean
  /** A same-id `pty:spawn` (the recovery relaunch) is mid-flight: its state must not be torn down. */
  isSpawnInFlight: (ptyId: string) => boolean
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
  const isCurrent = ({ id, incarnationId }: { id: string; incarnationId?: string }): boolean =>
    deps.isCurrentPtyExit({ id, ...(incarnationId ? { incarnationId } : {}) })
  return async (event) => {
    // Why: a pty id the runtime already moved to a newer incarnation was respawned by some other
    // trigger before this announcement landed; it is not a casualty any more.
    const lost = event.sessions.filter(isCurrent)
    if (lost.length === 0) {
      // Why: a loss announcement that finds only stale ids must not vanish without a trace.
      deps.recordBreadcrumb('daemon_sessions_lost', {
        count: 0,
        applied: 0,
        notified: false,
        stale: event.sessions.length,
        ...(event.sinceDisconnectMs === undefined
          ? {}
          : { sinceDisconnectMs: event.sinceDisconnectMs })
      })
      return
    }
    // Audit and plan read state that onPtyExit / clearProviderPtyState tear down, so both come first.
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
    // Why: an id whose same-id relaunch spawn is mid-flight is still audited (the gate needs it) but
    // must not be notified or exited. Re-checked after the plan's await: a concurrent respawn wins.
    const toApply = lost.filter(
      (session) => isCurrent(session) && !deps.isSpawnInFlight(session.id)
    )
    // No await from here on: main cannot service the renderer's relaunch before every exit is applied.
    let notified = false
    if (plan) {
      const applyIds = new Set(toApply.map(({ id }) => id))
      const sessions = plan
        .filter((entry) => applyIds.has(entry.id) && !entry.peerOwned)
        .map(({ id, paneKey, reanchor }) => ({ id, paneKey, reanchor }))
      if (sessions.length > 0) {
        try {
          // Why before the exits: the renderer must capture while the pane's live status still exists.
          notified = deps.sendToRenderer({ epoch: event.epoch, sessions })
        } catch (error) {
          console.error('[daemon] sessions-lost notice to the window failed:', error)
        }
      }
    }
    for (const { id, incarnationId } of toApply) {
      deps.applyProviderPtyExitState({
        id,
        code: DAEMON_LOSS_EXIT_CODE,
        ...(incarnationId ? { incarnationId } : {})
      })
    }
    deps.recordBreadcrumb('daemon_sessions_lost', {
      count: lost.length,
      applied: toApply.length,
      notified,
      ...(event.sessions.length > lost.length
        ? { stale: event.sessions.length - lost.length }
        : {}),
      ...(lost.length > toApply.length ? { inFlight: lost.length - toApply.length } : {}),
      ...(event.sinceDisconnectMs === undefined
        ? {}
        : { sinceDisconnectMs: event.sinceDisconnectMs })
    })
  }
}
