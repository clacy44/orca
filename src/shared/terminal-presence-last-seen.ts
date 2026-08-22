/** Elapsed minutes for a stale presence row's "last seen Nm ago" copy, shared by the renderer surfaces
 *  and the CLI roster so the two can never phrase the same silence differently.
 *
 *  `lastSeenAt` is stamped on the HOST clock (the domain `lastOutputAt` already publishes in) while
 *  `now` is the reader's, so the floor of 1 is load-bearing: a reader whose clock trails the host's
 *  would otherwise render "last seen 0m ago" on a row the host only marks past two minutes. */
export function terminalPresenceLastSeenMinutes(lastSeenAt: number, now: number): number {
  return Math.max(1, Math.round((now - lastSeenAt) / 60_000))
}
