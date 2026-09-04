// Rotating capture of the detached daemon's stderr (hotfix 10k-2 H10, incident 2026-09-04
// §2.2(a)). The launcher used to destroy the parent's read end at readiness, which discarded
// every native write (V8 OOM banner, native module abort) from that instant on — there was no
// record anywhere. This keeps the pipe's content, appending it to its own rotated file (never
// daemon.log: that file is NDJSON, parsed line-wise by classifyPredecessorLogEnd, and raw crash
// text would corrupt that scan). Writes are async and best-effort: a failure disables the log
// rather than throwing, and never applies backpressure to the daemon's own fd 2.

import { appendFile } from 'node:fs/promises'
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'

export const DAEMON_STDERR_LOG_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
export const DAEMON_STDERR_LOG_MAX_ROTATED_FILES = 2 // daemon.stderr.log + .1 + .2
export const DAEMON_STDERR_TAIL_LINES = 40

export type DaemonStderrLog = {
  /** Append a raw chunk read from the daemon's stderr. Fire-and-forget; never throws. */
  write(chunk: Buffer): void
  /** Best-effort last DAEMON_STDERR_TAIL_LINES non-empty lines seen, oldest first. */
  getTailLines(): string[]
  /** Resolves once every write() queued so far has landed (or failed) on disk. Test seam. */
  flush(): Promise<void>
  /** Stop accepting writes. */
  close(): void
}

export function createDaemonStderrLog(
  filePath: string,
  opts: { maxBytes?: number; maxRotatedFiles?: number; tailLines?: number } = {}
): DaemonStderrLog {
  const maxBytes = opts.maxBytes ?? DAEMON_STDERR_LOG_MAX_BYTES
  const maxRotatedFiles = opts.maxRotatedFiles ?? DAEMON_STDERR_LOG_MAX_ROTATED_FILES
  const tailLines = opts.tailLines ?? DAEMON_STDERR_TAIL_LINES

  let disabled = false
  let currentBytes = 0
  let writeChain: Promise<void> = Promise.resolve()
  let breadcrumbEmitted = false
  const tail: string[] = []

  try {
    mkdirSync(dirname(filePath), { recursive: true })
    currentBytes = existsSync(filePath) ? statSync(filePath).size : 0
  } catch {
    disabled = true
  }

  function pushTail(text: string): void {
    for (const line of text.split('\n')) {
      if (line.length === 0) {
        continue
      }
      tail.push(line)
      if (tail.length > tailLines) {
        tail.shift()
      }
    }
  }

  // Cascade rename base → .1 → .2, dropping the oldest — same policy as daemon-file-log.ts.
  function rotate(): void {
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
    currentBytes = 0
  }

  function onWriteFailure(error: unknown): void {
    // Why: EPIPE / ENOSPC / EACCES all land here — drop future writes rather than retry into
    // the same failure, and say so exactly once so the drop itself isn't silent.
    disabled = true
    if (breadcrumbEmitted) {
      return
    }
    breadcrumbEmitted = true
    recordDurableCrashBreadcrumb(
      'daemon_stderr_log_write_failed',
      {},
      error instanceof Error ? error.message : String(error)
    )
  }

  return {
    write(chunk: Buffer): void {
      if (disabled) {
        return
      }
      const text = chunk.toString('utf8')
      pushTail(text)
      const bytes = Buffer.byteLength(text, 'utf8')
      // Why: chain onto the previous write so rotation and appends can't interleave under a
      // burst — this only serializes the parent's file writes, never the daemon's own fd 2.
      writeChain = writeChain
        .then(async () => {
          if (disabled) {
            return
          }
          if (currentBytes > 0 && currentBytes + bytes > maxBytes) {
            rotate()
          }
          await appendFile(filePath, text)
          currentBytes += bytes
        })
        .catch(onWriteFailure)
    },
    getTailLines(): string[] {
      return [...tail]
    },
    flush(): Promise<void> {
      return writeChain.catch(() => {})
    },
    close(): void {
      disabled = true
    }
  }
}
