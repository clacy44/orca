// Why: last_heartbeat_at is written either as SQLite's timezone-less space format (datetime('now'))
// or as the offset-bearing ISO the send path stamps — the same split getStaleDispatches works
// around with julianday(). Normalize at read so the age is right on both write paths.
const SQLITE_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

export type DispatchHeartbeatLiveness = {
  lastHeartbeatAt?: string
  heartbeatAgeMs?: number
}

export function parseOrchestrationTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(
    SQLITE_UTC_TIMESTAMP_RE.test(value) ? `${value.replace(' ', 'T')}Z` : value
  )
  return Number.isNaN(parsed) ? null : parsed
}

// Why absent, never zero: a Dispatch that has never heartbeated has no age, and a 0 there reads
// as "heard from just now" — the exact false-green this whole surface exists to remove.
export function summarizeDispatchHeartbeat(
  lastHeartbeatAt: string | null | undefined,
  now: number = Date.now()
): DispatchHeartbeatLiveness {
  const at = parseOrchestrationTimestampMs(lastHeartbeatAt)
  if (at === null) {
    return {}
  }
  return { lastHeartbeatAt: new Date(at).toISOString(), heartbeatAgeMs: Math.max(0, now - at) }
}
