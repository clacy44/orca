/**
 * The credential lane a persisted live Claude session id was pinned to (S9 §2f, §3 row 6).
 *
 * Persisted BESIDE `claudeLivePtySessionIds` rather than replacing it: a state written by an
 * older build carries the ids and no lanes, and a seed with no lane attribution must defer every
 * account rather than silently reading as the shared lane's.
 */
export type ClaudeLivePtySessionLane = {
  sessionId: string
  /** A principal id, or `live-pty-gate`'s reserved shared-lane key. */
  laneId: string
}

/**
 * The cap the id list this array shadows already carries: a corrupt or hand-edited state file
 * must not be held in memory unbounded until the next spawn prunes it.
 */
export const MAX_CLAUDE_LIVE_PTY_SESSION_LANES = 200

/** Drops anything that is not a `{ sessionId, laneId }` pair of bounded, non-empty strings. */
export function normalizeClaudeLivePtySessionLanes(value: unknown): ClaudeLivePtySessionLane[] {
  if (!Array.isArray(value)) {
    return []
  }
  // Newest-first, matching how the id list evicts: the cap keeps the most recent rows.
  const rows = new Map<string, ClaudeLivePtySessionLane>()
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const entry = value[index]
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const { sessionId, laneId } = entry as Record<string, unknown>
    if (
      typeof sessionId !== 'string' ||
      typeof laneId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.length > 512 ||
      laneId.length === 0 ||
      laneId.length > 512
    ) {
      continue
    }
    if (!rows.has(sessionId)) {
      rows.set(sessionId, { sessionId, laneId })
    }
    if (rows.size >= MAX_CLAUDE_LIVE_PTY_SESSION_LANES) {
      break
    }
  }
  return [...rows.values()].toReversed()
}
