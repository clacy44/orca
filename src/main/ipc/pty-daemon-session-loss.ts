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

/** Per-call options: the manual restart announces the ids it killed through this same handler. */
export type DaemonSessionLossOptions = {
  /** The caller already wrote the `daemon_died` audit rows for these ids (restart step 1). */
  auditWritten?: boolean
  /** What announced the loss; carried into the breadcrumb only. */
  cause?: string
  /** Bounds the recovery plan; on timeout the plan is treated as failed. The crash path passes none. */
  planTimeoutMs?: number
  /** Restart path: an id that is neither notified nor peer-owned gets today's renderer exit. */
  exitUnnotified?: boolean
  /** Re-checked after the plan: true when the id's exit was already forwarded (so it is no casualty now). */
  excludeAfterPlan?: (id: string) => boolean
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
  /** Renderer `pty:exit` (the exit listener's second half); only used with `exitUnnotified`. */
  sendExitToRenderer?: (payload: { id: string; code: number; incarnationId?: string }) => void
  /** Returns false when there is no usable window (nothing is sent). */
  sendToRenderer: (payload: DaemonSessionsLostRendererPayload) => boolean
  recordBreadcrumb: (name: string, data: Record<string, string | number | boolean>) => void
}

// Why: the daemon died, so the process exited abnormally; mirrors the synthetic-exit code.
const DAEMON_LOSS_EXIT_CODE = -1

export function createDaemonSessionLossHandler(
  deps: DaemonSessionLossDeps
): (event: PtySessionsLostToDaemonDeathEvent, options?: DaemonSessionLossOptions) => Promise<void> {
  const isCurrent = ({ id, incarnationId }: { id: string; incarnationId?: string }): boolean =>
    deps.isCurrentPtyExit({ id, ...(incarnationId ? { incarnationId } : {}) })
  const planWithin = async (
    lost: readonly { id: string; incarnationId?: string }[],
    timeoutMs: number | undefined,
    onTimeout: () => void
  ): Promise<DaemonLossRecoveryPlanEntry[] | null> => {
    const planning = deps.planRecovery(lost)
    if (timeoutMs === undefined) {
      return planning
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    try {
      const plan = await Promise.race([planning, timedOut])
      if (plan === null) {
        onTimeout()
        console.warn(`[daemon] daemon-loss recovery plan timed out after ${timeoutMs}ms`)
        // Why: the loser may still reject later; nobody is waiting for it.
        planning.catch(() => {})
      }
      return plan
    } finally {
      clearTimeout(timer)
    }
  }
  return async (event, options) => {
    const causeData: Record<string, string> = options?.cause ? { cause: options.cause } : {}
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
          : { sinceDisconnectMs: event.sinceDisconnectMs }),
        ...causeData
      })
      return
    }
    // Audit and plan read state that onPtyExit / clearProviderPtyState tear down, so both come first.
    // Why skippable: the manual restart writes the audit at its own step 1 (one row per death).
    if (!options?.auditWritten) {
      try {
        deps.notifyDaemonDiedFanout(lost.map(({ id }) => id))
      } catch (error) {
        console.error('[daemon] daemon_died audit for lost sessions failed:', error)
      }
    }
    let plan: DaemonLossRecoveryPlanEntry[] | null = null
    let planTimedOut = false
    try {
      plan = await planWithin(lost, options?.planTimeoutMs, () => {
        planTimedOut = true
      })
    } catch (error) {
      console.error('[daemon] daemon-loss recovery plan failed:', error)
    }
    // Why: an id whose same-id relaunch spawn is mid-flight is still audited (the gate needs it) but
    // must not be notified or exited. Re-checked after the plan's await: a concurrent respawn wins.
    const superseded = lost.filter(
      (session) => isCurrent(session) && options?.excludeAfterPlan?.(session.id)
    ).length
    const toApply = lost.filter(
      (session) =>
        isCurrent(session) &&
        !deps.isSpawnInFlight(session.id) &&
        !options?.excludeAfterPlan?.(session.id)
    )
    // No await from here on: main cannot service the renderer's relaunch before every exit is applied.
    let notified = false
    const notifiedIds = new Set<string>()
    if (plan) {
      const applyIds = new Set(toApply.map(({ id }) => id))
      const sessions = plan
        .filter((entry) => applyIds.has(entry.id) && !entry.peerOwned)
        .map(({ id, paneKey, reanchor }) => ({ id, paneKey, reanchor }))
      if (sessions.length > 0) {
        try {
          // Why before the exits: the renderer must capture while the pane's live status still exists.
          notified = deps.sendToRenderer({ epoch: event.epoch, sessions })
          if (notified) {
            for (const { id } of sessions) {
              notifiedIds.add(id)
            }
          }
        } catch (error) {
          console.error('[daemon] sessions-lost notice to the window failed:', error)
        }
      }
    }
    const peerOwnedIds = new Set(
      (plan ?? []).filter((entry) => entry.peerOwned).map(({ id }) => id)
    )
    let exited = 0
    for (const { id, incarnationId } of toApply) {
      const payload = {
        id,
        code: DAEMON_LOSS_EXIT_CODE,
        ...(incarnationId ? { incarnationId } : {})
      }
      deps.applyProviderPtyExitState(payload)
      // Why: restart path only. A pane that is not recovered (no plan, no window, or not an agent
      // pane) must still close as it did before; peer-owned panes keep R315's main-only close.
      if (options?.exitUnnotified && !notifiedIds.has(id) && !peerOwnedIds.has(id)) {
        deps.sendExitToRenderer?.(payload)
        exited += 1
      }
    }
    deps.recordBreadcrumb('daemon_sessions_lost', {
      count: lost.length,
      applied: toApply.length,
      notified,
      ...(event.sessions.length > lost.length
        ? { stale: event.sessions.length - lost.length }
        : {}),
      ...(lost.length - superseded > toApply.length
        ? { inFlight: lost.length - superseded - toApply.length }
        : {}),
      ...(superseded > 0 ? { superseded } : {}),
      ...(options?.exitUnnotified ? { exited } : {}),
      ...(planTimedOut ? { planTimedOut: true } : {}),
      ...(event.sinceDisconnectMs === undefined
        ? {}
        : { sinceDisconnectMs: event.sinceDisconnectMs }),
      ...causeData
    })
  }
}
