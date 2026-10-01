import type { DaemonFileLog } from './daemon-file-log'
import { createRateLimitedEventLog } from './daemon-rate-limited-event-log'
import type { ForegroundScanAnomaly } from './pty-subprocess'

const FOREGROUND_SCAN_ANOMALY_LOG_INTERVAL_MS = 10 * 60_000

/** daemon.log `foreground-scan-stale-ppid`, at most once per session per 10 min; counts only, never command lines or paths. */
export function createForegroundScanAnomalyLog(
  log: DaemonFileLog,
  now?: () => number
): (sessionId: string, anomaly: ForegroundScanAnomaly) => void {
  const emit = createRateLimitedEventLog(
    log,
    'foreground-scan-stale-ppid',
    FOREGROUND_SCAN_ANOMALY_LOG_INTERVAL_MS,
    now
  )
  return (sessionId, anomaly) =>
    emit(sessionId, {
      sessionIdSuffix: sessionId.slice(-10),
      staleEdgesSkipped: anomaly.staleEdgesSkipped,
      rowCount: anomaly.rowCount,
      descendantCount: anomaly.descendantCount,
      fresh: anomaly.fresh
    })
}
