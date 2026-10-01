import type { DaemonFileLog } from './daemon-file-log'

/** Exit codes a daemon uses to say why it ended itself; DAEMON_EXIT_ENDPOINT_OCCUPIED (20) lives with endpoint ownership. */
export const DAEMON_EXIT_STALL = 21
export const DAEMON_EXIT_HEAP_PRESSURE = 22

/** Ends the daemon process with an attributed code once the caller has logged why. */
export function createDaemonProcessExit(log: DaemonFileLog, code: number): () => void {
  return () => {
    log.close()
    process.exit(code)
  }
}
