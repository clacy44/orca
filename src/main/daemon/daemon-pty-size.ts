import type { DaemonFileLog } from './daemon-file-log'
import { createRateLimitedEventLog } from './daemon-rate-limited-event-log'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
// Why: the headless emulator allocates every row synchronously, so an absurd size is a heap bomb.
const MAX_COLS = 4096
const MAX_ROWS = 2048
const RESIZE_REJECTED_LOG_INTERVAL_MS = 60_000

export function isValidPtySize(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 1 &&
    rows >= 1 &&
    cols <= MAX_COLS &&
    rows <= MAX_ROWS
  )
}

export function normalizePtySize(cols: number, rows: number): { cols: number; rows: number } {
  if (isValidPtySize(cols, rows)) {
    return { cols, rows }
  }
  return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
}

/** daemon.log `resize-rejected`, rate-limited per session. */
export function createResizeRejectedLog(
  log: DaemonFileLog,
  now?: () => number
): (sessionId: string, size: { cols: number; rows: number }) => void {
  const emit = createRateLimitedEventLog(
    log,
    'resize-rejected',
    RESIZE_REJECTED_LOG_INTERVAL_MS,
    now
  )
  return (sessionId, { cols, rows }) =>
    emit(sessionId, { sessionIdSuffix: sessionId.slice(-10), cols, rows })
}
