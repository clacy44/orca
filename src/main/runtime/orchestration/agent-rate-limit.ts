// S10-1 CONTAINMENT #10: fixed-window rate limiting over agent_rate. Split out of
// agent-directory.ts (kept out of db.ts per the repo's ratchet rule for that file) to stay
// under the max-lines ratchet.
import type Database from '../../sqlite/sync-database'

export type CheckAndBumpRateParams = {
  subjectKey: string
  verb: string
  windowMs: number
  limit: number
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number }

function rateWindowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs
}

// S10-15 (INV-P-006): agent_rate is a peer-writable, otherwise-unbounded-growth table (every
// distinct subject_key/verb/window_start triple a caller can provoke mints a row) — pruned
// opportunistically on every bump rather than requiring a separate reaper. Retention is the
// larger of the CALLER'S OWN windowMs or one hour, so a short-window caller's history is not
// pruned mid-window (the current window's row is always kept) while a long-window caller still
// gets a floor: an unusually large windowMs cannot be used to make its own rows immortal.
const AGENT_RATE_MIN_RETENTION_MS = 60 * 60 * 1000

/** Fixed-window rate limiter over agent_rate. Refuses with a retryAfterMs, never a partial
 * result — the caller must not bump the counter and then act as if it had been refused. */
export function checkAndBumpRate(
  db: Database.Database,
  params: CheckAndBumpRateParams
): RateLimitResult {
  const nowMs = Date.now()
  const windowStartMs = rateWindowStart(nowMs, params.windowMs)
  // window_start is ISO-8601 (unlike most of this schema's TEXT timestamps, which are
  // datetime('now') — 'YYYY-MM-DD HH:MM:SS'); any cross-column comparison against those must go
  // through julianday(), never a bare TEXT compare, or the differing formats sort wrong.
  const windowStart = new Date(windowStartMs).toISOString()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db
      .prepare(
        'SELECT count FROM agent_rate WHERE subject_key = ? AND verb = ? AND window_start = ?'
      )
      .get(params.subjectKey, params.verb, windowStart) as { count: number } | undefined
    const count = row?.count ?? 0
    if (count >= params.limit) {
      db.exec('COMMIT')
      return { allowed: false, retryAfterMs: windowStartMs + params.windowMs - nowMs }
    }
    db.prepare(
      `INSERT INTO agent_rate (subject_key, verb, window_start, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(subject_key, verb, window_start) DO UPDATE SET count = count + 1`
    ).run(params.subjectKey, params.verb, windowStart)
    // Opportunistic prune, same transaction: never touches the current window's own row (its
    // window_start is never older than the retention threshold).
    const retentionMs = Math.max(params.windowMs, AGENT_RATE_MIN_RETENTION_MS)
    const pruneThreshold = new Date(nowMs - retentionMs).toISOString()
    db.prepare('DELETE FROM agent_rate WHERE window_start < ?').run(pruneThreshold)
    db.exec('COMMIT')
    return { allowed: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
