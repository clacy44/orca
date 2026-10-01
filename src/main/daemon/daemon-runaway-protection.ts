/** D-26b: the daemon's R314 runaway protections, bundled so daemon-entry stays small. */
import type { DaemonFileLog } from './daemon-file-log'
import { createDaemonProcessExit, DAEMON_EXIT_HEAP_PRESSURE } from './daemon-exit-codes'
import { createForegroundScanAnomalyLog } from './daemon-foreground-scan-anomaly-log'
import { startDaemonStallWatchdog } from './daemon-stall-watchdog'
import type { ForegroundScanAnomaly } from './pty-subprocess'

export type DaemonRunawayProtection = {
  /** Heap-pressure guard exit: logs nothing itself (daemon_heap_exit is already written), ends the process. */
  onHeapPressureExit: () => void
  foregroundScanAnomalyFor: (sessionId: string) => (anomaly: ForegroundScanAnomaly) => void
  /** The worker writes the log file directly while the main thread is blocked; without a path it only protects. */
  startStallWatchdog: () => () => void
}

export function createDaemonRunawayProtection(
  log: DaemonFileLog,
  logFilePath: string | undefined
): DaemonRunawayProtection {
  const logForegroundScanAnomaly = createForegroundScanAnomalyLog(log)
  return {
    onHeapPressureExit: createDaemonProcessExit(log, DAEMON_EXIT_HEAP_PRESSURE),
    foregroundScanAnomalyFor: (sessionId) => (anomaly) =>
      logForegroundScanAnomaly(sessionId, anomaly),
    startStallWatchdog: () => startDaemonStallWatchdog({ log, logFilePath }).stop
  }
}
