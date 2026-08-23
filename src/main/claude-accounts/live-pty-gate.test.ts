import { afterEach, describe, expect, it, vi } from 'vitest'
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
    endClaudeAuthSwitch()
  })

  it('allows switching while Claude PTYs are live', () => {
    markClaudePtySpawned('live-claude-pty', null)

    beginClaudeAuthSwitch()

    expect(isClaudeAuthSwitchInProgress()).toBe(true)
  })

  it('still rejects overlapping account switches', () => {
    beginClaudeAuthSwitch()

    expect(() => beginClaudeAuthSwitch()).toThrow('already in progress')
  })

  it('counts seeded session ids as live until confirmed dead', () => {
    seedLiveClaudePtysFromPersistence(['seeded-pty-1', 'seeded-pty-2'])

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
    seedLiveClaudePtysFromPersistence(['seeded-pty-1', 'seeded-pty-2'])

    confirmSeededClaudeLivePtys(['seeded-pty-2'])

    expect(hasLiveClaudePtys()).toBe(true)
    expect(removeClaudeLivePtySessionId).toHaveBeenCalledWith('seeded-pty-1')
    expect(removeClaudeLivePtySessionId).not.toHaveBeenCalledWith('seeded-pty-2')
  })

  it('keeps a seeded id confirmed by a real spawn out of later pruning', () => {
    seedLiveClaudePtysFromPersistence(['seeded-pty-1'])
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
      seedLiveClaudePtysFromPersistence(['seeded-pty-1'])

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
    expect(addClaudeLivePtySessionId).toHaveBeenCalledWith('live-claude-pty')

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
    seedLiveClaudePtysFromPersistence(['seeded-pty-1'])
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
