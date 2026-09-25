// Item D (D-23-1 section (d)): the Resource popover polls enumerateWindowsProcessResources every
// 2s; single-flight + a 5s result cache must cut ~30 host-wide scans/min while it's open down to
// ~12, without a cached result advancing the successive-sample CPU chain (start-time guard,
// :77-114 at the time of writing).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void
  ) => execFileMock(file, args, opts, cb)
}))

async function loadCollector() {
  vi.resetModules()
  return await import('./windows-process-resource-collector')
}

function cimRow(pid: number, ppid: number, memory: number, startTicks: string): string {
  return [pid, ppid, memory, '0', '0', startTicks].join('\t')
}

describe('enumerateWindowsProcessResources single-flight + result cache', () => {
  let nowMs = 0

  beforeEach(() => {
    execFileMock.mockReset()
    nowMs = 0
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockCimResponse(): void {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => {
      cb(null, cimRow(10, 1, 1024, '1000'), '')
    })
  }

  it('bounds 2s polls over 60s to <=12 scans (5s cache)', async () => {
    mockCimResponse()
    const { enumerateWindowsProcessResources } = await loadCollector()

    for (let atMs = 0; atMs <= 60_000; atMs += 2_000) {
      nowMs = atMs
      await enumerateWindowsProcessResources()
    }

    expect(execFileMock.mock.calls.length).toBeLessThanOrEqual(12)
  })

  it('coalesces concurrent callers during one scan into a single spawn', async () => {
    let resolveScan: (() => void) | undefined
    execFileMock.mockImplementation((_file, _args, _opts, cb) => {
      resolveScan = () => cb(null, cimRow(10, 1, 1024, '1000'), '')
    })
    const { enumerateWindowsProcessResources } = await loadCollector()

    const callers = [
      enumerateWindowsProcessResources(),
      enumerateWindowsProcessResources(),
      enumerateWindowsProcessResources(),
      enumerateWindowsProcessResources()
    ]
    expect(execFileMock).toHaveBeenCalledTimes(1)
    resolveScan?.()
    const results = await Promise.all(callers)

    expect(execFileMock).toHaveBeenCalledTimes(1)
    for (const rows of results) {
      expect(rows).toEqual([{ pid: 10, ppid: 1, cpu: 0, memory: 1024 }])
    }
  })

  it('does not advance the CPU sample history on a cached-result hit within 5s', async () => {
    let call = 0
    execFileMock.mockImplementation((_file, _args, _opts, cb) => {
      call += 1
      // Distinct working-set values per real scan so a cache hit (no new scan) is detectable:
      // if the cache were bypassed, the second poll's CPU-sample baseline would move.
      cb(null, cimRow(10, 1, 1024 * call, '1000'), '')
    })
    const { enumerateWindowsProcessResources } = await loadCollector()

    const first = await enumerateWindowsProcessResources()
    nowMs = 1_000
    const second = await enumerateWindowsProcessResources()

    // Cache hit: same memory reading, no second execFile call.
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)

    nowMs = 5_500 // now 5.5s since the first scan: cache expired
    const third = await enumerateWindowsProcessResources()
    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(third[0]!.memory).toBe(1024 * 2)
  })
})
