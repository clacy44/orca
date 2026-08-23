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

/** Drops anything that is not a `{ sessionId, laneId }` pair of bounded, non-empty strings. */
export function normalizeClaudeLivePtySessionLanes(value: unknown): ClaudeLivePtySessionLane[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows = new Map<string, ClaudeLivePtySessionLane>()
  for (const entry of value) {
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
    rows.set(sessionId, { sessionId, laneId })
  }
  return [...rows.values()]
}
