import { describe, expect, it } from 'vitest'
import { LaneCapabilityProbe } from './lane-delegation-capability-probe'

function makeProbe(now: () => number) {
  const logLines: string[] = []
  const probe = new LaneCapabilityProbe({
    hostId: 'host-1',
    now,
    log: (line) => logLines.push(line)
  })
  return { probe, logLines }
}

describe('LaneCapabilityProbe', () => {
  it('starts unknown and allows an immediate first attempt', () => {
    const { probe } = makeProbe(() => 0)
    expect(probe.currentState).toBe('unknown')
    expect(probe.supported).toBe(false)
    expect(probe.shouldAttempt()).toBe(true)
  })

  it('a failure never marks unsupported; it stays unknown and blocks the next attempt until backoff elapses', () => {
    let now = 0
    const { probe } = makeProbe(() => now)
    expect(probe.shouldAttempt()).toBe(true)
    probe.recordFailure()
    expect(probe.currentState).toBe('unknown')
    expect(probe.supported).toBe(false)
    expect(probe.shouldAttempt()).toBe(false)
    now += 4_999
    expect(probe.shouldAttempt()).toBe(false)
    now += 1
    expect(probe.shouldAttempt()).toBe(true)
  })

  it('caps exponential backoff at 60s (5s, 10s, 20s, 40s, 60s, 60s...)', () => {
    let now = 0
    const { probe } = makeProbe(() => now)
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      expect(probe.shouldAttempt()).toBe(true)
      probe.recordFailure()
      expect(probe.shouldAttempt()).toBe(false)
      now += delay - 1
      expect(probe.shouldAttempt()).toBe(false)
      now += 1
    }
    expect(probe.shouldAttempt()).toBe(true)
  })

  it('resets backoff to the initial delay on success', () => {
    let now = 0
    const { probe } = makeProbe(() => now)
    probe.recordFailure()
    probe.recordFailure()
    probe.recordFailure()
    now += 100
    probe.recordSuccess(true)
    expect(probe.currentState).toBe('supported')
    // A confirmed `supported` host is never re-verified — forceReprobe (reconnect) is a no-op.
    probe.forceReprobe('reconnect')
    expect(probe.currentState).toBe('supported')
    expect(probe.shouldAttempt()).toBe(false)
  })

  it('an explicit ok-but-absent result marks unsupported, sticky until its TTL elapses', () => {
    let now = 0
    const { probe } = makeProbe(() => now)
    probe.recordSuccess(false)
    expect(probe.currentState).toBe('unsupported')
    expect(probe.supported).toBe(false)
    expect(probe.shouldAttempt()).toBe(false)
    now += 10 * 60 * 1000 - 1
    expect(probe.shouldAttempt()).toBe(false)
    expect(probe.currentState).toBe('unsupported')
    now += 1
    expect(probe.shouldAttempt()).toBe(true)
    expect(probe.currentState).toBe('unknown')
  })

  it('forceReprobe clears unsupported immediately, ahead of the TTL', () => {
    const { probe } = makeProbe(() => 0)
    probe.recordSuccess(false)
    expect(probe.currentState).toBe('unsupported')
    probe.forceReprobe('reconnect')
    expect(probe.currentState).toBe('unknown')
    expect(probe.shouldAttempt()).toBe(true)
  })

  it('forceReprobe does not bypass a pending backoff on an unknown host', () => {
    let now = 0
    const { probe } = makeProbe(() => now)
    probe.recordFailure()
    expect(probe.shouldAttempt()).toBe(false)
    probe.forceReprobe('reconnect')
    expect(probe.currentState).toBe('unknown')
    expect(probe.shouldAttempt()).toBe(false)
  })

  it('logs exactly one line per state transition, never per retry', () => {
    let now = 0
    const { probe, logLines } = makeProbe(() => now)
    probe.recordFailure()
    now += 5_000
    probe.recordFailure()
    now += 10_000
    probe.recordFailure()
    expect(logLines).toEqual([])
    probe.recordSuccess(true)
    expect(logLines).toHaveLength(1)
    expect(logLines[0]).toContain('unknown -> supported')
  })

  it('logs the unsupported -> unknown transition once on TTL expiry, and once on forceReprobe', () => {
    let now = 0
    const { probe, logLines } = makeProbe(() => now)
    probe.recordSuccess(false)
    expect(logLines).toHaveLength(1)
    expect(logLines[0]).toContain('unknown -> unsupported')
    now += 10 * 60 * 1000
    expect(probe.shouldAttempt()).toBe(true)
    expect(logLines).toHaveLength(2)
    expect(logLines[1]).toContain('unsupported -> unknown')
    probe.recordSuccess(false)
    probe.forceReprobe('reconnect')
    expect(logLines).toHaveLength(4)
    expect(logLines[3]).toContain('unsupported -> unknown')
  })
})
