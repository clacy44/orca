// Append-only NDJSON logger for the detached daemon process. The daemon runs
// out-of-process with stdio 'ignore', so console output goes nowhere; this
// writes lifecycle events to a rotated file under the app's logs directory so
// they land in diagnostic bundles (windows-terminal-update-survival-plan.md
// §Phase 0). Never log terminal input/output content or tokens.
//
// Two hard constraints:
//   1. FAIL-OPEN. Any error (EACCES, ENOSPC, bad path) disables logging and is
//      swallowed — logging must never throw into daemon lifecycle logic or
//      affect startup/shutdown.
//   2. Best-effort durability. Each line is a single synchronous appendFileSync
//      so a process death mid-write can lose at most the last (partial) line;
//      NDJSON readers skip a truncated trailing line.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { dirname } from 'node:path'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const DEFAULT_MAX_ROTATED_FILES = 2 // daemon.log + daemon.log.1 + daemon.log.2
const PRIVATE_FILE_MODE = 0o600

/** Total files in the rotated daemon-log family (active + rotated). The bundle
 *  collector passes this to `listRotatedFiles` so it reads every rotated file. */
export const DAEMON_LOG_MAX_FILES = DEFAULT_MAX_ROTATED_FILES + 1

export type DaemonFileLog = {
  /** Append one lifecycle event. Terse fields only — never user data. */
  log(event: string, details?: Record<string, unknown>): void
  /** Best-effort marker that no further writes are expected. */
  close(): void
}

export type DaemonFileLogOptions = {
  readonly maxBytes?: number
  readonly maxRotatedFiles?: number
}

/** No-op logger used when the daemon was launched without `--log-file` (adopted
 *  old daemons, tests). Keeps every call site unconditional. */
export function createNoopDaemonFileLog(): DaemonFileLog {
  return {
    log() {},
    close() {}
  }
}

export function createDaemonFileLog(
  filePath: string,
  opts: DaemonFileLogOptions = {}
): DaemonFileLog {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRotatedFiles = opts.maxRotatedFiles ?? DEFAULT_MAX_ROTATED_FILES

  let disabled = false
  let currentBytes = 0

  function disable(): void {
    disabled = true
  }

  try {
    mkdirSync(dirname(filePath), { recursive: true })
    currentBytes = existsSync(filePath) ? statSync(filePath).size : 0
  } catch {
    // Unwritable path — stay fail-open; the first log() no-ops via `disabled`.
    disable()
  }

  // Cascade rename base → .1 → .2, dropping the oldest, then reset the active
  // file. Any failure disables logging rather than risking a partial-rotation
  // loop that keeps throwing on every subsequent line.
  function rotate(): void {
    // With no rotated slots there is nothing to cascade; return without the
    // `currentBytes = 0` reset below, which would otherwise falsely report the
    // still-growing active file as empty and defeat the overflow check forever.
    if (maxRotatedFiles < 1) {
      return
    }
    try {
      for (let i = maxRotatedFiles; i >= 1; i--) {
        const src = i === 1 ? filePath : `${filePath}.${i - 1}`
        const dst = `${filePath}.${i}`
        if (!existsSync(src)) {
          continue
        }
        if (existsSync(dst)) {
          unlinkSync(dst)
        }
        renameSync(src, dst)
      }
      currentBytes = 0
    } catch {
      disable()
    }
  }

  function log(event: string, details: Record<string, unknown> = {}): void {
    if (disabled) {
      return
    }
    let line: string
    try {
      line = `${JSON.stringify({
        src: 'daemon',
        ts: new Date().toISOString(),
        pid: process.pid,
        event,
        ...details
      })}\n`
    } catch {
      // Non-serializable detail (circular ref) — drop the line, never crash.
      return
    }
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (currentBytes > 0 && currentBytes + lineBytes > maxBytes) {
      rotate()
      if (disabled) {
        return
      }
    }
    try {
      appendFileSync(filePath, line, { mode: PRIVATE_FILE_MODE })
      currentBytes += lineBytes
    } catch {
      disable()
    }
  }

  return {
    log,
    close(): void {
      // Best-effort marker; append is synchronous so there is nothing to flush.
      log('daemon-log-closed')
      disabled = true
    }
  }
}

// S10-12 R4: every generation shares one rotated log file, so a new daemon's own 'startup'
// line sits right after whatever its predecessor last wrote. Classifying that tail — BEFORE
// this process appends anything — turns "no shutdown line" from the only forensic signal for
// a silent death into one classified line per generation boundary, written on every start.
export type PredecessorEndClassification =
  | 'clean_shutdown'
  | 'fatal_exception'
  | 'endpoint_lost'
  | 'login_session_retired'
  | 'aborted_start'
  | 'silent_death'
  | 'no_predecessor'

export type PredecessorEndVerdict = {
  classification: PredecessorEndClassification
  lastEvent?: string
  lastPid?: number
}

// Written by every graceful exit path (shutdown()'s finally, onIdleShutdown, onRpcShutdown,
// the login-session-dead-retire crash-style exit) — the one line common to all of them.
const CLEAN_TERMINAL_EVENT = 'daemon-log-closed'
// Diagnosable-but-abrupt: the process attributed its own end before dying, just without the
// close() that would make it 'clean_shutdown'.
const DIAGNOSABLE_ABRUPT_EVENTS: Readonly<Record<string, PredecessorEndClassification>> = {
  'uncaught-exception-fatal': 'fatal_exception',
  'endpoint-ownership-lost': 'endpoint_lost'
}
// S10-12 R4 fix: onRetire logs this immediately before close() — a crash-style exit (no PTY
// teardown, per daemon-entry.ts's own comment) that the terminal 'daemon-log-closed' marker
// which follows it would otherwise misreport as an ordinary clean_shutdown.
const ABNORMAL_EVENTS_BEFORE_CLOSE: Readonly<Record<string, PredecessorEndClassification>> = {
  'login-session-dead-retire': 'login_session_retired'
}
// S10-12 R4 fix: every generation appends its own 'startup' (and 'predecessor-end', if it had
// a predecessor) BEFORE startDaemon() runs. A process that dies in that narrow window — e.g.
// losing the endpoint-occupied race, whose catch exits with no daemonLog.close() and no
// terminal marker at all — leaves one of these two events as the file's last line. That is not
// a mid-run silent death; the next generation must not read it that way.
const ABORTED_START_EVENTS = new Set(['startup', 'predecessor-end'])

/** Fail-open: any read/parse trouble reads as 'no_predecessor', never throws — this must not
 *  block daemon startup any more than logging itself may. */
export function classifyPredecessorLogEnd(filePath: string): PredecessorEndVerdict {
  let raw: string
  try {
    if (!existsSync(filePath) || statSync(filePath).size === 0) {
      return { classification: 'no_predecessor' }
    }
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return { classification: 'no_predecessor' }
  }
  const lines = raw.split('\n')
  // Set once a CLEAN_TERMINAL_EVENT line is seen scanning backward; classification is not
  // returned immediately because the ATTRIBUTING line that precedes it (if any) must be
  // checked first — a crash-style close still writes the same terminal marker.
  let pendingCleanClose: { lastPid?: number } | null = null
  // Why last-to-first: a truncated trailing line (the predecessor died mid-write) must not
  // shadow the last COMPLETE line before it.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) {
      continue
    }
    let parsed: { event?: unknown; pid?: unknown }
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const event = typeof parsed.event === 'string' ? parsed.event : undefined
    if (!event) {
      continue
    }
    const lastPid = typeof parsed.pid === 'number' ? parsed.pid : undefined
    if (pendingCleanClose) {
      const abnormal = Object.hasOwn(ABNORMAL_EVENTS_BEFORE_CLOSE, event)
        ? ABNORMAL_EVENTS_BEFORE_CLOSE[event]
        : undefined
      if (abnormal) {
        return { classification: abnormal, lastEvent: event, lastPid }
      }
      return {
        classification: 'clean_shutdown',
        lastEvent: CLEAN_TERMINAL_EVENT,
        lastPid: pendingCleanClose.lastPid
      }
    }
    if (event === CLEAN_TERMINAL_EVENT) {
      pendingCleanClose = { lastPid }
      continue
    }
    const diagnosable = DIAGNOSABLE_ABRUPT_EVENTS[event]
    if (diagnosable) {
      return { classification: diagnosable, lastEvent: event, lastPid }
    }
    if (ABORTED_START_EVENTS.has(event)) {
      return { classification: 'aborted_start', lastEvent: event, lastPid }
    }
    return { classification: 'silent_death', lastEvent: event, lastPid }
  }
  if (pendingCleanClose) {
    return {
      classification: 'clean_shutdown',
      lastEvent: CLEAN_TERMINAL_EVENT,
      lastPid: pendingCleanClose.lastPid
    }
  }
  return { classification: 'no_predecessor' }
}
