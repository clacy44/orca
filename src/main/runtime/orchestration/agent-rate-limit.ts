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
// opportunistically on every bump rather than requiring a separate reaper. The prune is scoped
// to the CALLER'S OWN verb (verifier V-1): an unscoped prune keyed only on window_start lets a
// short-window bump (e.g. MINUTE_MS) from any subject delete another verb's longer-window rows
// (e.g. a DAY_MS quarantine counter) before they are stale for their own verb. Retention is
// exactly that verb's windowMs — the current window's own row is never older than the
// threshold, so it is never pruned mid-window.

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
    // Opportunistic prune, same transaction: scoped to this caller's own verb (V-1 fix) so a
    // bump from one verb/window can never delete another verb's rows. Never touches the current
    // window's own row (its window_start is never older than the retention threshold).
    const pruneThreshold = new Date(nowMs - params.windowMs).toISOString()
    db.prepare('DELETE FROM agent_rate WHERE verb = ? AND window_start < ?').run(
      params.verb,
      pruneThreshold
    )
    db.exec('COMMIT')
    return { allowed: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
