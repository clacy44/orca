/** The mobile staleness horizon and the "last seen Nm ago" copy computed from it, shared by the host
 *  registry, the renderer surfaces and the CLI roster so no two of them can phrase the same silence
 *  differently — or disagree about when the silence started counting. */

/** Why 120 s and not the ~60 s a runtime-scope heartbeat bounds: the phone's only inbound traffic while
 *  a screen is open is foreground- and screen-scoped polling, so a shorter window would mark a phone the
 *  user is holding. Long enough to outlive a backgrounded tab switch, short enough that a dead phone
 *  stops reading as "here" while the reader still cares. */
export const MOBILE_PRESENCE_STALE_MS = 120_000

/** Elapsed minutes for a stale presence row's "last seen Nm ago" copy.
 *
 *  `lastSeenAt` is stamped on the HOST clock (the domain `lastOutputAt` already publishes in) while
 *  `now` is the reader's, so the floor of 1 is load-bearing: a reader whose clock trails the host's
 *  would otherwise render "last seen 0m ago" on a row the host only marks past two minutes. */
export function terminalPresenceLastSeenMinutes(lastSeenAt: number, now: number): number {
  return Math.max(1, Math.round((now - lastSeenAt) / 60_000))
}
