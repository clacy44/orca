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

describe('readDaemonStderrTail (generation-scoped, H16 Ruling 35 Addendum 3 R3)', () => {
  function markerLine(pid: number, at = '2026-09-05T00:00:00.000Z'): string {
    return formatDaemonStderrLogMarker({ pid, entryHash: 'abc123def456', startedAt: at })
  }

  it("returns the last N non-empty lines written after this pid's marker, oldest first", () => {
    writeFileSync(filePath, `${markerLine(4242)}line1\nline2\nline3\nline4\n`)
    expect(readDaemonStderrTail(filePath, 4242, { tailLines: 2 })).toBe('line3\nline4')
  })

  it("never attributes a NEWER generation's tail to an older pid, or vice versa — each pid's window stops at the next marker", () => {
    writeFileSync(
      filePath,
      `${markerLine(1111)}old generation crash text\n${markerLine(2222)}line-a\nline-b\n`
    )
    // The new generation's read stops before it, never sees pid 1111's text.
    expect(readDaemonStderrTail(filePath, 2222)).toBe('line-a\nline-b')
    // The old generation's own read is exactly its own text — bounded at the NEXT marker,
    // never bleeding into pid 2222's text that was appended after it in the shared file.
    expect(readDaemonStderrTail(filePath, 1111)).toBe('old generation crash text')
  })

  it("returns '' when this generation's marker is absent (startup failure before any write) — fail-open, never a stale tail", () => {
    writeFileSync(filePath, `${markerLine(9999)}unrelated pid's text\n`)
    expect(readDaemonStderrTail(filePath, 4321)).toBe('')
  })

  it('slices at the LAST occurrence of a marker when a pid is reused across generations', () => {
    writeFileSync(
      filePath,
      `${markerLine(5000)}first run text\n${markerLine(5000)}second run text\n`
    )
    expect(readDaemonStderrTail(filePath, 5000)).toBe('second run text')
  })

  it('rejects an invalid pid (non-positive or non-integer) — fail-open', () => {
    writeFileSync(filePath, `${markerLine(4242)}line1\n`)
    expect(readDaemonStderrTail(filePath, 0)).toBe('')
    expect(readDaemonStderrTail(filePath, -1)).toBe('')
    expect(readDaemonStderrTail(filePath, Number.NaN)).toBe('')
  })

  it('bounds the read to maxReadBytes without reading a much larger file whole, as long as the window reaches the marker', () => {
    // A large prior generation's text, then this generation's marker and 2000 lines.
    const priorGeneration = 'z'.repeat(200_000)
    const lines = Array.from({ length: 2000 }, (_, i) => String(i).padStart(10, '0'))
    const marker = markerLine(7)
    const thisGeneration = `${marker}${lines.join('\n')}\n`
    writeFileSync(filePath, `${priorGeneration}${thisGeneration}`)
    // Bounded to just enough to cover this generation's own marker + content — far less than
    // the 200 KB+ total file size, proving the read genuinely does not scan the whole file.
    const maxReadBytes = Buffer.byteLength(thisGeneration) + 16
    const tail = readDaemonStderrTail(filePath, 7, { maxReadBytes, tailLines: 40 })
    expect(tail).toContain('1999')
    expect(tail).not.toContain('0000000000')
  })

  it("returns '' when maxReadBytes is too small to reach this generation's marker — fail-open, never a truncated guess", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => String(i).padStart(10, '0'))
    writeFileSync(filePath, `${markerLine(7)}${lines.join('\n')}\n`)
    expect(readDaemonStderrTail(filePath, 7, { maxReadBytes: 100, tailLines: 40 })).toBe('')
  })

  it('produces a tail long enough to fill the crash-report *_stack lane (>= 4000 chars) for a long burst', () => {
    // A native-abort stack can run to hundreds of frames; 40 lines of a realistic frame width
    // comfortably clears the 4000-char *_stack budget this tail feeds (crash-reporting.ts).
    const frame =
      '    at Object.<anonymous> (/app/out/main/daemon-entry.js:123:45) some.native.frame.padding.to.reach.a.realistic.line.width'
    const lines = Array.from({ length: 60 }, (_, i) => `${frame} #${i}`)
    writeFileSync(filePath, `${markerLine(42)}${lines.join('\n')}\n`)
    const tail = readDaemonStderrTail(filePath, 42)
    expect(tail.length).toBeGreaterThanOrEqual(4000)
  })

  it('returns an empty string when the file does not exist (fail-open)', () => {
    expect(readDaemonStderrTail(join(dir, 'missing.log'), 4242)).toBe('')
  })
})
