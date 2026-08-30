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

/** Fixed-window rate limiter over agent_rate. Refuses with a retryAfterMs, never a partial
 * result — the caller must not bump the counter and then act as if it had been refused. */
export function checkAndBumpRate(
  db: Database.Database,
  params: CheckAndBumpRateParams
): RateLimitResult {
  const nowMs = Date.now()
  const windowStartMs = rateWindowStart(nowMs, params.windowMs)
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
    db.exec('COMMIT')
    return { allowed: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
