import { afterEach, describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  attachClaudeLivePtyPersistence,
  beginClaudeAuthSwitch,
  confirmSeededClaudeLivePtys,
  endClaudeAuthSwitch,
  hasLiveClaudePtys,
  hasLiveClaudePtysInLane,
  hasUnattributedLiveClaudePtys,
  isClaudeAuthSwitchInProgress,
  isEphemeralClaudePty,
  listLanesWithLiveClaudePtys,
  markClaudePtyExited,
  markClaudePtySpawned,
  markEphemeralClaudePtyExited,
  markEphemeralClaudePtySpawned,
  onLiveClaudePtysDrained,
  seedLiveClaudePtysFromPersistence,
  SHARED_CLAUDE_LANE_KEY
} from './live-pty-gate'

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'

describe('Claude live PTY gate', () => {
  afterEach(() => {
    markClaudePtyExited('lane-a-pty')
    markClaudePtyExited('lane-b-pty')
    markClaudePtyExited('shared-pty')
    markClaudePtyExited('live-claude-pty')
    markClaudePtyExited('seeded-pty-1')
    markClaudePtyExited('seeded-pty-2')
    confirmSeededClaudeLivePtys([])
    attachClaudeLivePtyPersistence(null)
    markClaudePtyExited('seeded-lane-pty')
    endClaudeAuthSwitch(SHARED_CLAUDE_LANE_KEY)
    endClaudeAuthSwitch(LANE_A)
    endClaudeAuthSwitch(LANE_B)
  })

  it('allows switching while Claude PTYs are live', () => {
    markClaudePtySpawned('live-claude-pty', null)

    beginClaudeAuthSwitch(SHARED_CLAUDE_LANE_KEY)

    expect(isClaudeAuthSwitchInProgress(SHARED_CLAUDE_LANE_KEY)).toBe(true)
  })

  it('still rejects overlapping account switches in the same lane with a typed refusal', () => {
    beginClaudeAuthSwitch(LANE_A)

    // S9-L1 §modules D: a typed `ClaudeLaneRefusal`, not a bare `Error` — the untyped throw a
    // client has no string table for (§3 Rule 3).
    expect(() => beginClaudeAuthSwitch(LANE_A)).toThrow('already running')
    try {
      beginClaudeAuthSwitch(LANE_A)
      expect.unreachable()
    } catch (error) {
      expect(isClaudeLaneRefusal(error)).toBe(true)
      expect((error as { code: string }).code).toBe('accounts.lane.switch_in_progress')
    }
  })

  it('leaves another lane, and the shared lane, un-gated by a lane switch (S9 §2f)', () => {
    beginClaudeAuthSwitch(LANE_A)

    expect(isClaudeAuthSwitchInProgress(LANE_A)).toBe(true)
    expect(isClaudeAuthSwitchInProgress(LANE_B)).toBe(false)
    expect(isClaudeAuthSwitchInProgress(SHARED_CLAUDE_LANE_KEY)).toBe(false)
  })

  it('leaves every principal lane un-gated by a HOST switch (S9 §5 S9c)', () => {
    beginClaudeAuthSwitch(SHARED_CLAUDE_LANE_KEY)

    expect(isClaudeAuthSwitchInProgress(LANE_A)).toBe(false)
    expect(isClaudeAuthSwitchInProgress(LANE_B)).toBe(false)
  })

  it('counts seeded session ids as live until confirmed dead', () => {
    seedLiveClaudePtysFromPersistence([
      { sessionId: 'seeded-pty-1', laneId: null },
      { sessionId: 'seeded-pty-2', laneId: null }
    ])

    expect(hasLiveClaudePtys()).toBe(true)

    confirmSeededClaudeLivePtys(['seeded-pty-1'])

    expect(hasLiveClaudePtys()).toBe(true)

    confirmSeededClaudeLivePtys([])

    expect(hasLiveClaudePtys()).toBe(true)

    markClaudePtyExited('seeded-pty-1')

    expect(hasLiveClaudePtys()).toBe(false)
  })

  it('releases seeded ids the daemon no longer knows', () => {
    const removeClaudeLivePtySessionId = vi.fn()
    attachClaudeLivePtyPersistence({
      addClaudeLivePtySessionId: vi.fn(),
      removeClaudeLivePtySessionId
    })
    seedLiveClaudePtysFromPersistence([
      { sessionId: 'seeded-pty-1', laneId: null },
      { sessionId: 'seeded-pty-2', laneId: null }
    ])

    confirmSeededClaudeLivePtys(['seeded-pty-2'])

    expect(hasLiveClaudePtys()).toBe(true)
    expect(removeClaudeLivePtySessionId).toHaveBeenCalledWith('seeded-pty-1')
    expect(removeClaudeLivePtySessionId).not.toHaveBeenCalledWith('seeded-pty-2')
  })

  it('keeps a seeded id confirmed by a real spawn out of later pruning', () => {
    seedLiveClaudePtysFromPersistence([{ sessionId: 'seeded-pty-1', laneId: null }])
    markClaudePtySpawned('seeded-pty-1', null)

    confirmSeededClaudeLivePtys([])

    expect(hasLiveClaudePtys()).toBe(true)
  })

  it('notifies drain listeners only when the last live Claude PTY exits', () => {
    const onDrained = vi.fn()
    const unsubscribe = onLiveClaudePtysDrained(onDrained)
    try {
      markClaudePtySpawned('live-claude-pty', null)
      markClaudePtySpawned('seeded-pty-1', null)

      markClaudePtyExited('live-claude-pty')
      expect(onDrained).not.toHaveBeenCalled()

      markClaudePtyExited('seeded-pty-1')
      expect(onDrained).toHaveBeenCalledTimes(1)

      // Why: exits with no live PTYs left must not fire again — the drain
      // signal marks the 1 -> 0 transition, not every teardown call.
      markClaudePtyExited('seeded-pty-1')
      expect(onDrained).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  it('notifies drain listeners when seed reconciliation releases the last live id', () => {
    const onDrained = vi.fn()
    const unsubscribe = onLiveClaudePtysDrained(onDrained)
    try {
      seedLiveClaudePtysFromPersistence([{ sessionId: 'seeded-pty-1', laneId: null }])

      confirmSeededClaudeLivePtys([])

      expect(onDrained).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  it('stops notifying an unsubscribed drain listener', () => {
    const onDrained = vi.fn()
    const unsubscribe = onLiveClaudePtysDrained(onDrained)
    unsubscribe()

    markClaudePtySpawned('live-claude-pty', null)
    markClaudePtyExited('live-claude-pty')

    expect(onDrained).not.toHaveBeenCalled()
  })

  it('persists spawns and exits when persistence is attached', () => {
    const addClaudeLivePtySessionId = vi.fn()
    const removeClaudeLivePtySessionId = vi.fn()
    attachClaudeLivePtyPersistence({
      addClaudeLivePtySessionId,
      removeClaudeLivePtySessionId
    })

    markClaudePtySpawned('live-claude-pty', null)
    expect(addClaudeLivePtySessionId).toHaveBeenCalledWith(
      'live-claude-pty',
      SHARED_CLAUDE_LANE_KEY
    )

    markClaudePtySpawned('lane-a-pty', LANE_A)
    expect(addClaudeLivePtySessionId).toHaveBeenCalledWith('lane-a-pty', LANE_A)

    markClaudePtyExited('live-claude-pty')
    expect(removeClaudeLivePtySessionId).toHaveBeenCalledWith('live-claude-pty')
  })
  it('answers the lane liveness query per lane, and forgets it on exit', () => {
    markClaudePtySpawned('lane-a-pty', 'lane-a')
    markClaudePtySpawned('lane-b-pty', 'lane-b')

    expect(hasLiveClaudePtysInLane('lane-a')).toBe(true)
    expect(hasLiveClaudePtysInLane('lane-b')).toBe(true)
    // Negative control: a lane nobody spawned into holds nothing.
    expect(hasLiveClaudePtysInLane('lane-c')).toBe(false)
    expect(hasUnattributedLiveClaudePtys()).toBe(false)

    markClaudePtyExited('lane-a-pty')
    expect(hasLiveClaudePtysInLane('lane-a')).toBe(false)
    expect(hasLiveClaudePtysInLane('lane-b')).toBe(true)
  })

  it('attributes a shared-lane spawn to the host lane rather than to nobody', () => {
    markClaudePtySpawned('shared-pty', null)
    // L1 forbids a lane's account also being the shared one, so this defers no lane's rotation.
    expect(hasUnattributedLiveClaudePtys()).toBe(false)
    expect(hasLiveClaudePtysInLane(SHARED_CLAUDE_LANE_KEY)).toBe(true)
    // Negative control: it answers for the shared lane and for no provisioned lane.
    expect(hasLiveClaudePtysInLane('lane-a')).toBe(false)
    markClaudePtyExited('shared-pty')
    expect(hasLiveClaudePtysInLane(SHARED_CLAUDE_LANE_KEY)).toBe(false)
  })

  it('reports only a seeded, unreconciled id as unattributed', () => {
    seedLiveClaudePtysFromPersistence([{ sessionId: 'seeded-pty-1', laneId: null }])
    // A restored id carries no lane, so it must defer every account's rotation.
    expect(hasUnattributedLiveClaudePtys()).toBe(true)
    confirmSeededClaudeLivePtys([])
    expect(hasUnattributedLiveClaudePtys()).toBe(false)
  })

  describe("the lane usage probe's synthetic gate id (S9 §2k)", () => {
    const GATE_ID = 'lane-usage-probe:lane-a:abc'

    it("defers its own lane's rotation and no other lane's", () => {
      markEphemeralClaudePtySpawned(GATE_ID, 'lane-a')

      expect(hasLiveClaudePtys()).toBe(true)
      expect(hasLiveClaudePtysInLane('lane-a')).toBe(true)
      expect(hasLiveClaudePtysInLane('lane-b')).toBe(false)
      expect(listLanesWithLiveClaudePtys()).toEqual(['lane-a'])

      markEphemeralClaudePtyExited(GATE_ID)
      expect(hasLiveClaudePtys()).toBe(false)
    })

    // Mutation-proof anchor: registering through the PERSISTING arm would seed the synthetic id
    // back at the next startup and defer that account's rotation until reconciliation dropped it.
    it('never reaches the persisted live-PTY session list', () => {
      const addClaudeLivePtySessionId = vi.fn()
      const removeClaudeLivePtySessionId = vi.fn()
      attachClaudeLivePtyPersistence({ addClaudeLivePtySessionId, removeClaudeLivePtySessionId })

      markEphemeralClaudePtySpawned(GATE_ID, 'lane-a')
      expect(isEphemeralClaudePty(GATE_ID)).toBe(true)
      expect(addClaudeLivePtySessionId).not.toHaveBeenCalled()

      markEphemeralClaudePtyExited(GATE_ID)
      expect(removeClaudeLivePtySessionId).not.toHaveBeenCalled()
      expect(isEphemeralClaudePty(GATE_ID)).toBe(false)
    })

    it('notifies the drain listeners when the probe was the last live claude', () => {
      const drained = vi.fn()
      const stop = onLiveClaudePtysDrained(drained)
      markEphemeralClaudePtySpawned(GATE_ID, 'lane-a')
      markEphemeralClaudePtyExited(GATE_ID)
      stop()

      expect(drained).toHaveBeenCalledTimes(1)
    })
  })
})

// §2f/§3 row 6: a seed that names its lane defers only that lane; one without names defers all.
describe('seeding the gate from persistence', () => {
  afterEach(() => {
    markClaudePtyExited('seeded-lane-pty')
    markClaudePtyExited('seeded-legacy-pty')
    confirmSeededClaudeLivePtys([])
  })

  it('attributes a seeded id that carries a lane', () => {
    seedLiveClaudePtysFromPersistence([{ sessionId: 'seeded-lane-pty', laneId: LANE_A }])

    expect(hasLiveClaudePtysInLane(LANE_A)).toBe(true)
    expect(hasLiveClaudePtysInLane(LANE_B)).toBe(false)
    expect(hasUnattributedLiveClaudePtys()).toBe(false)
  })

  it('defers every account for a pre-S9c seed with no lane', () => {
    seedLiveClaudePtysFromPersistence([{ sessionId: 'seeded-legacy-pty', laneId: null }])

    expect(hasUnattributedLiveClaudePtys()).toBe(true)

    confirmSeededClaudeLivePtys([])

    expect(hasUnattributedLiveClaudePtys()).toBe(false)
  })
})
