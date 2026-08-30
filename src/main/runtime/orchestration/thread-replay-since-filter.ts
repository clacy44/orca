const SQLITE_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

/**
 * `--since` arrives as the ISO-with-offset shape `exposeMessageTimestamps` (db.ts) hands back to
 * every reader; `created_at` is stored as timezone-less space-format UTC. Normalize so a string
 * comparison in SQL lines up with what a caller polling forward with a prior reply's own
 * `created_at` actually passes back in.
 */
export function normalizeThreadSinceTimestamp(since: string): string {
  if (SQLITE_UTC_TIMESTAMP_RE.test(since)) {
    return since
  }
  return since.replace('T', ' ').replace(/Z$/, '').slice(0, 19)
}
