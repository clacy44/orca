import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { closeSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatDaemonStderrLogMarker,
  readDaemonStderrTail,
  rotateAndOpenDaemonStderrLogFd,
  writeDaemonStderrLogMarker
} from './daemon-stderr-log'

let dir: string
let filePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-stderr-log-'))
  filePath = join(dir, 'daemon.stderr.log')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('rotateAndOpenDaemonStderrLogFd', () => {
  it('opens a real fd that a child process can be given as its stderr', () => {
    const fd = rotateAndOpenDaemonStderrLogFd(filePath)
    try {
      writeDaemonStderrLogMarker(fd, {
        pid: 4242,
        entryHash: 'abc123def456',
        startedAt: '2026-09-05T00:00:00.000Z'
      })
    } finally {
      closeSync(fd)
    }
    expect(readFileSync(filePath, 'utf8')).toBe(
      '=== daemon pid 4242 entry abc123def456 started 2026-09-05T00:00:00.000Z ===\n'
    )
  })

  it('rotates the file at open time when it already exceeds maxBytes, keeping maxRotatedFiles', () => {
    writeFileSync(filePath, 'x'.repeat(100))
    const fd = rotateAndOpenDaemonStderrLogFd(filePath, { maxBytes: 50, maxRotatedFiles: 2 })
    closeSync(fd)
    expect(readFileSync(`${filePath}.1`, 'utf8')).toBe('x'.repeat(100))
    expect(statSync(filePath).size).toBe(0)
  })

  it('does not rotate when the existing file is under maxBytes — generations share one file', () => {
    writeFileSync(filePath, 'small\n')
    const fd = rotateAndOpenDaemonStderrLogFd(filePath, { maxBytes: 1_000_000 })
    writeDaemonStderrLogMarker(fd, {
      pid: 1,
      entryHash: 'aaaaaaaaaaaa',
      startedAt: '2026-09-05T00:00:00.000Z'
    })
    closeSync(fd)
    const content = readFileSync(filePath, 'utf8')
    expect(content.startsWith('small\n')).toBe(true)
    expect(content).toContain('=== daemon pid 1 ')
  })
})

describe('formatDaemonStderrLogMarker', () => {
  it('formats pid, entry hash and timestamp into one line', () => {
    expect(
      formatDaemonStderrLogMarker({
        pid: 99,
        entryHash: 'deadbeef0000',
        startedAt: '2026-01-01T00:00:00.000Z'
      })
    ).toBe('=== daemon pid 99 entry deadbeef0000 started 2026-01-01T00:00:00.000Z ===\n')
  })
})

describe('readDaemonStderrTail', () => {
  it('returns the last N non-empty lines, oldest first', () => {
    writeFileSync(filePath, 'line1\nline2\nline3\nline4\n')
    expect(readDaemonStderrTail(filePath, { tailLines: 2 })).toBe('line3\nline4')
  })

  it('bounds the read to maxReadBytes even against a much larger file', () => {
    // 2000 lines of "0123456789\n" (11 bytes each) = 22000 bytes; read only the last 100.
    const lines = Array.from({ length: 2000 }, (_, i) => String(i).padStart(10, '0'))
    writeFileSync(filePath, `${lines.join('\n')}\n`)
    const tail = readDaemonStderrTail(filePath, { maxReadBytes: 100, tailLines: 40 })
    expect(tail).toContain('1999')
    expect(tail).not.toContain('0000000000')
  })

  it('produces a tail long enough to fill the crash-report *_stack lane (>= 4000 chars) for a long burst', () => {
    // A native-abort stack can run to hundreds of frames; 40 lines of a realistic frame width
    // comfortably clears the 4000-char *_stack budget this tail feeds (crash-reporting.ts).
    const frame =
      '    at Object.<anonymous> (/app/out/main/daemon-entry.js:123:45) some.native.frame.padding.to.reach.a.realistic.line.width'
    const lines = Array.from({ length: 60 }, (_, i) => `${frame} #${i}`)
    writeFileSync(filePath, `${lines.join('\n')}\n`)
    const tail = readDaemonStderrTail(filePath)
    expect(tail.length).toBeGreaterThanOrEqual(4000)
  })

  it('returns an empty string when the file does not exist (fail-open)', () => {
    expect(readDaemonStderrTail(join(dir, 'missing.log'))).toBe('')
  })
})
