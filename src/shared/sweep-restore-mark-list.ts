// S10-21a C15 (R52, D-V7 F1): the shape `orchestration:sweepRestoreMark:list` replies with.
// Additive over the prior bare `string[]` reply — no new IPC channel, one optional field —
// per the chair ruling in c15-brief.md. Shared so main (the handler), preload (the bridge
// type + the web-runtime stub) and the renderer (the hydration consumer) agree on one shape.
export type LiveAgentSessionMark = {
  /** The live terminal that holds the conversation; the mark is dropped when this pty exits. */
  ptyId: string
  paneKey: string
  worktreeId: string
  agent: string
  providerSessionId: string
}

/** Main -> renderer push of a fresh live-session mark set (payload: `LiveAgentSessionMark[]`). */
export const LIVE_AGENT_SESSIONS_CHANNEL = 'agentStatus:liveAgentSessions'

/** Key for "this provider session is held by a live terminal" lookups; the pane key is deliberately absent. */
export function liveAgentSessionKey(
  worktreeId: string,
  agent: string,
  providerSessionId: string
): string {
  return `${worktreeId}\0${agent}\0${providerSessionId}`
}

/** Reply of `app:reconcileLiveTerminalSurfaces`. The marks are read right after the reconcile, so a
 * startup that reconciles never needs the sweep-lock-gated `sweepRestoreMarkList` re-read. */
export type ReconcileLiveTerminalSurfacesReply = {
  /** Omitted when the live set is unknown (read failed, ptys not recoverable, inventory unavailable):
   * the renderer then keeps the marks it already holds. An empty array means "none are live". */
  liveAgentSessions?: LiveAgentSessionMark[]
}

export type SweepRestoreMarkListReply = {
  /** Every marked pane key for this host, as of the read. */
  paneKeys: string[]
  /** Agent conversations that a live local terminal in main's inventory still holds; no wake path
   * may resume them. Omitted when the live set is unknown; `[]` means none are live. */
  liveAgentSessions?: LiveAgentSessionMark[]
  /** True only when `awaitRestoreSweepLockRelease` hit its 30s bound before the sweep lock
   * released — `paneKeys` in that case is the pre-release (possibly incomplete) read, not the
   * post-sweep view. Omitted (not `false`) on the normal path. */
  sweepIncomplete?: boolean
}
