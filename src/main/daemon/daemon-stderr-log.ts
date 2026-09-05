// Rotating capture of the detached daemon's stderr (hotfix 10k-2 H10-v2, Ruling 35 Addendum 2,
// after D-R112). H10's first cut kept the parent's read end open and piped chunks into a file —
// but Node pipe writes are synchronous on the writer side: if Electron main stalls, the daemon
// itself blocks in write(2) once the 64 KB pipe fills, so a hotfix meant to diagnose daemon
// wedges could cause one. This version hands the daemon a raw file descriptor for its stderr at
// spawn time instead: the daemon (and any native abort) writes straight to disk, no parent-side
// pipe, no queue, no way for a stalled main to backpressure the daemon it exists to observe.
//
// Never merge into daemon.log: that file is NDJSON, parsed line-wise by classifyPredecessorLogEnd,
// and raw crash text would corrupt the classifier's tail scan.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'

export const DAEMON_STDERR_LOG_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
export const DAEMON_STDERR_LOG_MAX_ROTATED_FILES = 2 // daemon.stderr.log + .1 + .2
/** Total files in the rotated family (active + rotated) — for the bundle collector, mirroring DAEMON_LOG_MAX_FILES. */
export const DAEMON_STDERR_LOG_MAX_FILES = DAEMON_STDERR_LOG_MAX_ROTATED_FILES + 1
export const DAEMON_STDERR_TAIL_LINES = 40
// Why 64 KB: generous enough to contain 40 lines of any realistic native-abort stack while
// keeping the read bounded regardless of how large the file has grown since the last rotation.
export const DAEMON_STDERR_TAIL_READ_BYTES = 64 * 1024

// Cascade rename base → .1 → .2, dropping the oldest — same policy as daemon-file-log.ts.
function rotate(filePath: string, maxRotatedFiles: number): void {
  if (maxRotatedFiles < 1) {
    return
  }
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
}

/**
 * Rotate-if-oversized, then open the file for append and return the raw fd — the caller passes
 * this directly as the child's stdio[2] (`stdio: [..., ..., fd]`) so the daemon writes its own
 * stderr with no intermediary. The parent's copy of the fd is only needed long enough to write
 * the generation marker (writeDaemonStderrLogMarker) and must be closed right after — the caller
 * owns that lifecycle, not this module.
 */
export function rotateAndOpenDaemonStderrLogFd(
  filePath: string,
  opts: { maxBytes?: number; maxRotatedFiles?: number } = {}
): number {
  const maxBytes = opts.maxBytes ?? DAEMON_STDERR_LOG_MAX_BYTES
  const maxRotatedFiles = opts.maxRotatedFiles ?? DAEMON_STDERR_LOG_MAX_ROTATED_FILES
  mkdirSync(dirname(filePath), { recursive: true })
  try {
    if (existsSync(filePath) && statSync(filePath).size > maxBytes) {
      rotate(filePath, maxRotatedFiles)
    }
  } catch {
    // Why: a rotation failure (e.g. a rotated slot locked on Windows) must not block the daemon
    // launch — fall through and open/append the existing file as-is.
  }
  return openSync(filePath, 'a')
}

/** One line marking where a daemon generation's stderr begins, written by the parent through its
 *  own copy of the fd right after spawn (the pid is only known once fork() returns). */
export function formatDaemonStderrLogMarker(marker: {
  pid: number
  entryHash: string
  startedAt: string
}): string {
  return `=== daemon pid ${marker.pid} entry ${marker.entryHash} started ${marker.startedAt} ===\n`
}

export function writeDaemonStderrLogMarker(
  fd: number,
  marker: { pid: number; entryHash: string; startedAt: string }
): void {
  writeSync(fd, formatDaemonStderrLogMarker(marker))
}

export { closeSync as closeDaemonStderrLogFd }

// node:fs's readSync can return short reads; loop until the buffer is full or EOF.
function readSyncFull(fd: number, buffer: Buffer, position: number): number {
  let readTotal = 0
  while (readTotal < buffer.length) {
    const bytesRead = readSync(
      fd,
      buffer,
      readTotal,
      buffer.length - readTotal,
      position + readTotal
    )
    if (bytesRead <= 0) {
      break
    }
    readTotal += bytesRead
  }
  return readTotal
}

/** Bounded, best-effort read of the file's last DAEMON_STDERR_TAIL_LINES non-empty lines — reads
 *  at most DAEMON_STDERR_TAIL_READ_BYTES from the end, regardless of the file's total size.
 *  Fail-open: any read trouble (missing file, EACCES) returns ''. */
export function readDaemonStderrTail(
  filePath: string,
  opts: { maxReadBytes?: number; tailLines?: number } = {}
): string {
  const maxReadBytes = opts.maxReadBytes ?? DAEMON_STDERR_TAIL_READ_BYTES
  const tailLines = opts.tailLines ?? DAEMON_STDERR_TAIL_LINES
  try {
    const size = statSync(filePath).size
    const fd = openSync(filePath, 'r')
    try {
      const readLength = Math.min(size, maxReadBytes)
      const position = size - readLength
      const buffer = Buffer.alloc(readLength)
      const readTotal = readSyncFull(fd, buffer, position)
      const lines = buffer
        .subarray(0, readTotal)
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0)
      return lines.slice(-tailLines).join('\n')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}
