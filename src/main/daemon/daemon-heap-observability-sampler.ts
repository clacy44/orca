/**
 * Unconditional daemon self-report (R117 FIX 5): every 60s, one log line with heap/backlog state
 * so a memory-bound death leaves a trail attributing which hop — which client's socket, which
 * session's backlog — was congested. Unlike daemon-stream-backlog-probe.ts this is not env-gated.
 */
import { memoryUsage } from 'node:process'
import { getHeapStatistics } from 'node:v8'
import type { DaemonFileLog } from './daemon-file-log'

const SAMPLE_INTERVAL_MS = 60_000

export type HeapObservabilityClientSample = {
  clientId: string
  socketBufferedBytes: number
  batcherQueuedChars: number
}

export type HeapObservabilitySessionSample = {
  sessionId: string
  pendingOutputBytes: number
}

export type HeapObservabilitySample = {
  clients: HeapObservabilityClientSample[]
  sessions: HeapObservabilitySessionSample[]
}

export function startDaemonHeapObservabilitySampler(
  sample: () => HeapObservabilitySample,
  log: DaemonFileLog,
  intervalMs: number = SAMPLE_INTERVAL_MS
): () => void {
  const timer = setInterval(() => {
    const { heapUsed, rss } = memoryUsage()
    const { heap_size_limit: heapSizeLimit } = getHeapStatistics()
    const { clients, sessions } = sample()
    log.log('daemon-heap-sample', {
      heapUsed,
      heap_size_limit: heapSizeLimit,
      rss,
      clients,
      sessions
    })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
