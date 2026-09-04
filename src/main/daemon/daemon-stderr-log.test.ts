import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { recordDurableCrashBreadcrumbMock } = vi.hoisted(() => ({
  recordDurableCrashBreadcrumbMock: vi.fn()
}))

vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))

import { createDaemonStderrLog } from './daemon-stderr-log'

let dir: string
let filePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-stderr-log-'))
  filePath = join(dir, 'daemon.stderr.log')
  recordDurableCrashBreadcrumbMock.mockClear()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createDaemonStderrLog', () => {
  it('appends written chunks to the file', async () => {
    const log = createDaemonStderrLog(filePath)
    log.write(Buffer.from('FATAL ERROR: JavaScript heap out of memory\n'))
    log.write(Buffer.from('stack line 2\n'))
    await log.flush()
    expect(readFileSync(filePath, 'utf8')).toBe(
      'FATAL ERROR: JavaScript heap out of memory\nstack line 2\n'
    )
  })

  it('tracks the last N non-empty lines for the tail breadcrumb', async () => {
    const log = createDaemonStderrLog(filePath, { tailLines: 2 })
    log.write(Buffer.from('line1\nline2\nline3\n'))
    await log.flush()
    expect(log.getTailLines()).toEqual(['line2', 'line3'])
  })

  it('rotates at maxBytes, keeping maxRotatedFiles', async () => {
    const log = createDaemonStderrLog(filePath, { maxBytes: 20, maxRotatedFiles: 2 })
    // Each write is 11 bytes ("chunk-N\n" varies; keep fixed width for a deterministic byte count).
    for (let i = 0; i < 6; i++) {
      log.write(Buffer.from(`chunk-${i}\n`))
      await log.flush()
    }
    expect(existsSync(filePath)).toBe(true)
    expect(existsSync(`${filePath}.1`)).toBe(true)
    expect(existsSync(`${filePath}.2`)).toBe(true)
    expect(statSync(filePath).size).toBeLessThanOrEqual(20)
  })

  it('picks up the on-disk size of a pre-existing file rather than treating it as empty', async () => {
    const first = createDaemonStderrLog(filePath, { maxBytes: 1_000_000 })
    first.write(Buffer.from('pre-existing\n'))
    await first.flush()

    const second = createDaemonStderrLog(filePath, { maxBytes: 1_000_000 })
    second.write(Buffer.from('appended\n'))
    await second.flush()

    expect(readFileSync(filePath, 'utf8')).toBe('pre-existing\nappended\n')
  })

  it('drops future writes and emits one breadcrumb after a write failure', async () => {
    const log = createDaemonStderrLog(join(dir, 'missing-dir', 'daemon.stderr.log'), {
      maxBytes: 1_000_000
    })
    // Why: mkdirSync inside createDaemonStderrLog already created the parent, so force a real
    // failure by removing it out from under the writer before the first write lands.
    rmSync(join(dir, 'missing-dir'), { recursive: true, force: true })
    log.write(Buffer.from('first\n'))
    await log.flush()
    log.write(Buffer.from('second\n'))
    await log.flush()
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledTimes(1)
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith(
      'daemon_stderr_log_write_failed',
      {},
      expect.any(String)
    )
  })

  it('close() stops accepting further writes', async () => {
    const log = createDaemonStderrLog(filePath)
    log.write(Buffer.from('kept\n'))
    await log.flush()
    log.close()
    log.write(Buffer.from('dropped\n'))
    await log.flush()
    expect(readFileSync(filePath, 'utf8')).toBe('kept\n')
  })
})
