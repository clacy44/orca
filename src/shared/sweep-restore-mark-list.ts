// S10-21a C15 (R52, D-V7 F1): the shape `orchestration:sweepRestoreMark:list` replies with.
// Additive over the prior bare `string[]` reply — no new IPC channel, one optional field —
// per the chair ruling in c15-brief.md. Shared so main (the handler), preload (the bridge
// type + the web-runtime stub) and the renderer (the hydration consumer) agree on one shape.
export type SweepRestoreMarkListReply = {
  /** Every marked pane key for this host, as of the read. */
  paneKeys: string[]
  /** True only when `awaitRestoreSweepLockRelease` hit its 30s bound before the sweep lock
   * released — `paneKeys` in that case is the pre-release (possibly incomplete) read, not the
   * post-sweep view. Omitted (not `false`) on the normal path. */
  sweepIncomplete?: boolean
}
