/** The mobile staleness horizon and the "last seen Nm ago" copy computed from it, shared by the host
 *  registry, the renderer surfaces and the CLI roster so no two of them can phrase the same silence
 *  differently — or disagree about when the silence started counting. */

/** Why 120 s and not the ~60 s a runtime-scope heartbeat bounds: the phone's only inbound traffic while
 *  a screen is open is foreground- and screen-scoped polling, so a shorter window would mark a phone the
 *  user is holding. Long enough to outlive a backgrounded tab switch, short enough that a dead phone
 *  stops reading as "here" while the reader still cares. */
export const MOBILE_PRESENCE_STALE_MS = 120_000

/** The smallest count the host could have marked a row stale at, and therefore the smallest a reader may
 *  honestly print. */
const MOBILE_PRESENCE_STALE_FLOOR_MINUTES = Math.round(MOBILE_PRESENCE_STALE_MS / 60_000)

/** Elapsed minutes for a stale presence row's "last seen Nm ago" copy.
 *
 *  `lastSeenAt` is the HOST's clock (the domain `lastOutputAt` already publishes in) and `now` is the
 *  reader's — two unrelated machines for `orca environment roster`, which polls peers over the network.
 *  So the floor is the horizon itself, not one minute: a reader running behind the host must never print
 *  a number the host would not have marked stale at. Skew the other way still over-reports and nothing
 *  on this payload bounds it, which is why the copy says "last seen", not "silent for exactly". */
export function terminalPresenceLastSeenMinutes(lastSeenAt: number, now: number): number {
  return Math.max(MOBILE_PRESENCE_STALE_FLOOR_MINUTES, Math.round((now - lastSeenAt) / 60_000))
}
