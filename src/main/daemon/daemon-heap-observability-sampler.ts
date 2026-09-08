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
    // D-R164 L4: at ~20 idle sessions this line was ~1.7MB/day against a 5MB×3 rotation
    // (daemon-file-log.ts:26-27) — omit entries with nothing backed up; a congested hop is what
    // this line exists to attribute, and an idle one has nothing to say.
    log.log('daemon-heap-sample', {
      heapUsed,
      heap_size_limit: heapSizeLimit,
      rss,
      clients: clients.filter((c) => c.socketBufferedBytes > 0 || c.batcherQueuedChars > 0),
      sessions: sessions.filter((s) => s.pendingOutputBytes > 0)
    })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
