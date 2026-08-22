import { useEffect, useState } from 'react'

// Why a renderer-side timer rather than more wire traffic: the host publishes the stale flip exactly
// once — its falling edge is spent and re-arms nothing while the phone stays silent — and nothing else
// on this side ticks. Without it the one number the "last seen Nm ago" copy exists to carry is the one
// number that stops being true. `lastSeenAt` is already on the row, so the count is local to render.
const TERMINAL_PRESENCE_LAST_SEEN_TICK_MS = 60_000

/** Re-renders the caller once a minute while a stale row is on screen, and stops the moment it is not. */
export function useTerminalPresenceLastSeenTick(hasStaleRow: boolean): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!hasStaleRow) {
      return
    }
    const timer = setInterval(() => {
      setTick((count) => count + 1)
    }, TERMINAL_PRESENCE_LAST_SEEN_TICK_MS)
    return () => clearInterval(timer)
  }, [hasStaleRow])
}
