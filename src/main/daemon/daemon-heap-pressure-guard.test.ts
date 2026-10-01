// W2 (D-26b): the guard turns an anonymous heap death into a logged, early, attributed one.
import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import {
  destroyOverdeepSockets,
  startDaemonHeapPressureGuard,
  type HeapPressureAttribution
} from './daemon-heap-pressure-guard'

const LIMIT = 1000

function createHarness(ratios: number[]) {
  const log = { log: vi.fn(), close: vi.fn() }
  const shed = vi.fn(() => ({
    batcherSessions: 2,
    batcherDroppedChars: 4096,
    pendingSessionsOverflowed: 1,
    socketsDestroyed: 0
  }))
  const exit = vi.fn()
  const attribution: HeapPressureAttribution = {
    clients: [
      {
        clientId: 'c-busy',
        streamWritableLength: 9000,
        controlWritableLength: 70,
        batcherQueuedChars: 12
      },
      {
        clientId: 'c-idle',
        streamWritableLength: 0,
        controlWritableLength: 0,
        batcherQueuedChars: 0
      }
    ],
    sessions: [
      { sessionId: 'pty-session-aaaaaaaaaa', pendingOutputBytes: 500 },
      { sessionId: 'pty-session-bbbbbbbbbb', pendingOutputBytes: 0 }
    ]
  }
  let index = 0
  let clock = 0
  const guard = startDaemonHeapPressureGuard({
    log,
    readHeapStats: () => ({
      usedHeapBytes: (ratios[Math.min(index++, ratios.length - 1)] ?? 0) * LIMIT,
      heapLimitBytes: LIMIT
    }),
    readRss: () => 123,
    describe: () => attribution,
    shed,
    exit,
    now: () => clock,
    intervalMs: 5_000
  })
  const tick = (advanceMs = 5_000): void => {
    clock += advanceMs
    guard.check()
  }
  return { log, shed, exit, guard, tick }
}

const events = (log: { log: ReturnType<typeof vi.fn> }): string[] =>
  log.log.mock.calls.map((call) => call[0] as string)

describe('daemon heap-pressure guard', () => {
  it('does nothing below 50% of the heap limit', () => {
    const { log, shed, exit, guard, tick } = createHarness([0.1, 0.3, 0.499])
    tick()
    tick()
    tick()
    expect(log.log).not.toHaveBeenCalled()
    expect(shed).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    guard.stop()
  })

  it('logs daemon_heap_pressure with attribution at 50% and takes no action', () => {
    const { log, shed, exit, guard, tick } = createHarness([0.55])
    tick()
    expect(events(log)).toEqual(['daemon_heap_pressure'])
    expect(log.log.mock.calls[0][1]).toMatchObject({
      heapUsed: 550,
      heapLimit: LIMIT,
      ratio: 0.55,
      rss: 123,
      clients: [
        {
          clientId: 'c-busy',
          streamWritableLength: 9000,
          controlWritableLength: 70,
          batcherQueuedChars: 12
        }
      ],
      sessions: [{ sessionIdSuffix: 'aaaaaaaaaa', pendingOutputBytes: 500 }]
    })
    expect(shed).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    guard.stop()
  })

  it('rate-limits the 50% line but keeps checking', () => {
    const { log, guard, tick } = createHarness([0.55, 0.55, 0.55])
    tick(5_000)
    tick(5_000)
    expect(events(log)).toEqual(['daemon_heap_pressure'])
    tick(30_000)
    expect(events(log)).toEqual(['daemon_heap_pressure', 'daemon_heap_pressure'])
    guard.stop()
  })

  it('sheds at 70% and logs daemon_heap_shed with the outcome', () => {
    const { log, shed, exit, guard, tick } = createHarness([0.72])
    tick()
    expect(shed).toHaveBeenCalledTimes(1)
    expect(events(log)).toEqual(['daemon_heap_pressure', 'daemon_heap_shed'])
    expect(log.log.mock.calls[1][1]).toMatchObject({
      ratio: 0.72,
      batcherSessions: 2,
      batcherDroppedChars: 4096,
      pendingSessionsOverflowed: 1,
      socketsDestroyed: 0
    })
    expect(exit).not.toHaveBeenCalled()
    guard.stop()
  })

  it('keeps shedding every tick but rate-limits daemon_heap_shed to once per 30s', () => {
    const { log, shed, guard, tick } = createHarness([0.75, 0.75, 0.75, 0.75])
    tick(5_000)
    tick(5_000)
    expect(shed).toHaveBeenCalledTimes(2)
    expect(events(log).filter((e) => e === 'daemon_heap_shed')).toHaveLength(1)
    tick(30_000)
    expect(shed).toHaveBeenCalledTimes(3)
    expect(events(log).filter((e) => e === 'daemon_heap_shed')).toHaveLength(2)
    const second = log.log.mock.calls.filter((c) => c[0] === 'daemon_heap_shed')[1][1]
    expect(second).toMatchObject({ shedPasses: 2 })
    guard.stop()
  })

  it('logs daemon_heap_exit with attribution and exits at 85%', () => {
    const { log, shed, exit, guard, tick } = createHarness([0.9])
    tick()
    expect(events(log)).toEqual(['daemon_heap_exit'])
    expect(log.log.mock.calls[0][1]).toMatchObject({
      ratio: 0.9,
      clients: [{ clientId: 'c-busy' }],
      sessions: [{ sessionIdSuffix: 'aaaaaaaaaa' }]
    })
    expect(shed).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledTimes(1)
    tick()
    expect(exit).toHaveBeenCalledTimes(1)
    guard.stop()
  })

  it('runs on its own 5s interval until stopped', () => {
    vi.useFakeTimers()
    try {
      const log = { log: vi.fn(), close: vi.fn() }
      const readHeapStats = vi.fn(() => ({ usedHeapBytes: 10, heapLimitBytes: LIMIT }))
      const guard = startDaemonHeapPressureGuard({
        log,
        readHeapStats,
        readRss: () => 1,
        describe: () => ({ clients: [], sessions: [] }),
        shed: vi.fn(),
        exit: vi.fn()
      })
      vi.advanceTimersByTime(15_000)
      expect(readHeapStats).toHaveBeenCalledTimes(3)
      guard.stop()
      vi.advanceTimersByTime(15_000)
      expect(readHeapStats).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('destroyOverdeepSockets', () => {
  const socket = (writableLength: number): Socket =>
    ({ writableLength, destroyed: false, destroy: vi.fn() }) as unknown as Socket

  it('destroys only sockets past the ceiling, on both the control and stream sides', () => {
    const deepStream = socket(65 * 1024 * 1024)
    const deepControl = socket(65 * 1024 * 1024)
    const shallow = socket(1024)
    const clients = [
      { controlSocket: shallow, streamSocket: deepStream },
      { controlSocket: deepControl, streamSocket: null }
    ]
    expect(destroyOverdeepSockets(clients, 64 * 1024 * 1024)).toBe(2)
    expect(deepStream.destroy).toHaveBeenCalledTimes(1)
    expect(deepControl.destroy).toHaveBeenCalledTimes(1)
    expect(shallow.destroy).not.toHaveBeenCalled()
  })
})
