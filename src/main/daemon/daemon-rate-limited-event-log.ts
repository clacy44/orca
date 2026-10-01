import type { DaemonFileLog } from './daemon-file-log'

const MAX_TRACKED_KEYS = 256

export type RateLimitedEventLog = (key: string, details?: Record<string, unknown>) => void

/** One daemon.log line per key per interval; the next line after a quiet gap reports how many were swallowed. */
export function createRateLimitedEventLog(
  log: DaemonFileLog,
  event: string,
  intervalMs: number,
  now: () => number = Date.now
): RateLimitedEventLog {
  const state = new Map<string, { lastAt: number; suppressed: number }>()
  return (key, details = {}) => {
    const at = now()
    const entry = state.get(key)
    if (entry && at - entry.lastAt < intervalMs) {
      entry.suppressed += 1
      return
    }
    const suppressed = entry?.suppressed ?? 0
    if (!entry && state.size >= MAX_TRACKED_KEYS) {
      for (const [staleKey, stale] of state) {
        if (at - stale.lastAt >= intervalMs) {
          state.delete(staleKey)
        }
      }
      if (state.size >= MAX_TRACKED_KEYS) {
        state.delete(state.keys().next().value as string)
      }
    }
    state.set(key, { lastAt: at, suppressed: 0 })
    log.log(event, suppressed > 0 ? { ...details, suppressed } : details)
  }
}
