import { describe, expect, it } from 'vitest'
import {
  MAX_CLAUDE_LIVE_PTY_SESSION_LANES,
  normalizeClaudeLivePtySessionLanes
} from './claude-live-pty-session-lane'

const LANE_ID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

describe('normalizeClaudeLivePtySessionLanes', () => {
  it('drops anything that is not a bounded { sessionId, laneId } pair', () => {
    expect(
      normalizeClaudeLivePtySessionLanes([
        { sessionId: 'a', laneId: LANE_ID },
        { sessionId: '', laneId: LANE_ID },
        { sessionId: 'b', laneId: '' },
        { sessionId: 'c', laneId: 'x'.repeat(513) },
        { sessionId: 'x'.repeat(513), laneId: LANE_ID },
        { sessionId: 42, laneId: LANE_ID },
        null,
        'nope'
      ])
    ).toEqual([{ sessionId: 'a', laneId: LANE_ID }])
  })

  it('keeps the last row for a repeated session id', () => {
    expect(
      normalizeClaudeLivePtySessionLanes([
        { sessionId: 'a', laneId: 'host' },
        { sessionId: 'a', laneId: LANE_ID }
      ])
    ).toEqual([{ sessionId: 'a', laneId: LANE_ID }])
  })

  it('caps the array at the id list cap, keeping the newest rows', () => {
    // Why on LOAD and not only on the next spawn: `retainLivePtySessionLanes` prunes when an id is
    // added, so a corrupt or hand-edited state file is held in memory unbounded until then.
    const rows = normalizeClaudeLivePtySessionLanes(
      Array.from({ length: MAX_CLAUDE_LIVE_PTY_SESSION_LANES + 5 }, (_, index) => ({
        sessionId: `claude-${index}`,
        laneId: LANE_ID
      }))
    )

    expect(rows).toHaveLength(MAX_CLAUDE_LIVE_PTY_SESSION_LANES)
    expect(rows[0]?.sessionId).toBe('claude-5')
    expect(rows.at(-1)?.sessionId).toBe(`claude-${MAX_CLAUDE_LIVE_PTY_SESSION_LANES + 4}`)
  })
})
