import { describe, expect, it } from 'vitest'
import {
  MOBILE_PRESENCE_STALE_MS,
  terminalPresenceLastSeenMinutes
} from './terminal-presence-last-seen'

const HOST_STAMP = 1_700_000_000_000

describe('terminalPresenceLastSeenMinutes', () => {
  it('counts elapsed minutes once the silence is longer than the horizon', () => {
    expect(terminalPresenceLastSeenMinutes(HOST_STAMP, HOST_STAMP + 7 * 60_000)).toBe(7)
  })

  // The stamp is the HOST's clock and `now` is the reader's, and for `orca environment roster` those are
  // two unrelated machines. The host only publishes the row past the horizon, so a reader running behind
  // it must never print a count the host would not have marked stale at.
  it('never prints a count below the horizon, however far the reader clock trails', () => {
    expect(terminalPresenceLastSeenMinutes(HOST_STAMP, HOST_STAMP)).toBe(2)
    expect(terminalPresenceLastSeenMinutes(HOST_STAMP, HOST_STAMP - 10 * 60_000)).toBe(2)
    expect(terminalPresenceLastSeenMinutes(HOST_STAMP, HOST_STAMP + MOBILE_PRESENCE_STALE_MS)).toBe(
      2
    )
  })
})
