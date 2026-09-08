// R117 FIX 5: unconditional (no env gate) 60s daemon self-report.
import { describe, expect, it, vi } from 'vitest'
import { startDaemonHeapObservabilitySampler } from './daemon-heap-observability-sampler'
import type { DaemonFileLog } from './daemon-file-log'

function createFakeLog(): DaemonFileLog & {
  calls: [string, Record<string, unknown> | undefined][]
} {
  const calls: [string, Record<string, unknown> | undefined][] = []
  return {
    calls,
    log(event, details) {
      calls.push([event, details])
    },
    close() {}
  }
}

describe('startDaemonHeapObservabilitySampler', () => {
  it('logs one line with the documented shape on the first tick', () => {
    vi.useFakeTimers()
    try {
      const log = createFakeLog()
      const sample = vi.fn(() => ({
        clients: [{ clientId: 'client-1', socketBufferedBytes: 100, batcherQueuedChars: 200 }],
        sessions: [{ sessionId: 'session-1', pendingOutputBytes: 300 }]
      }))
      const stop = startDaemonHeapObservabilitySampler(sample, log)

      vi.advanceTimersByTime(60_000)

      expect(log.calls).toHaveLength(1)
      const [event, details] = log.calls[0]!
      expect(event).toBe('daemon-heap-sample')
      expect(typeof details?.heapUsed).toBe('number')
      expect(typeof details?.heap_size_limit).toBe('number')
      expect(typeof details?.rss).toBe('number')
      expect(details?.clients).toEqual([
        { clientId: 'client-1', socketBufferedBytes: 100, batcherQueuedChars: 200 }
      ])
      expect(details?.sessions).toEqual([{ sessionId: 'session-1', pendingOutputBytes: 300 }])

      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('samples every 60s, not more often and not less', () => {
    vi.useFakeTimers()
    try {
      const log = createFakeLog()
      const sample = vi.fn(() => ({ clients: [], sessions: [] }))
      const stop = startDaemonHeapObservabilitySampler(sample, log)

      vi.advanceTimersByTime(59_999)
      expect(log.calls).toHaveLength(0)

      vi.advanceTimersByTime(1)
      expect(log.calls).toHaveLength(1)

      vi.advanceTimersByTime(60_000)
      expect(log.calls).toHaveLength(2)

      stop()
      vi.advanceTimersByTime(60_000)
      expect(log.calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
