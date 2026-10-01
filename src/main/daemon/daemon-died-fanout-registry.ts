// [S10-21a C7d] Set once from index.ts: invoked with every ptyId whose daemon died, so main can
// write one 'daemon_died' audit row per pane. R315: split out of daemon-init.ts (which re-exports
// it) so ipc/pty.ts can announce a crash without importing daemon-init, which imports ipc/pty.ts.
let onDaemonDiedFanout: ((ptyIds: readonly string[]) => void) | null = null

export function setDaemonDiedFanoutHandler(
  handler: ((ptyIds: readonly string[]) => void) | null
): void {
  onDaemonDiedFanout = handler
}

/** Writes the per-pane `daemon_died` audit rows (restart fanout and, since R315, an unplanned daemon loss). */
export function notifyDaemonDiedFanout(ptyIds: readonly string[]): void {
  onDaemonDiedFanout?.(ptyIds)
}
