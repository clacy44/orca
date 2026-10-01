// W1 (D-26b): a synchronous runaway blocks the main thread, so only another thread can see and end it.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAEMON_EXIT_STALL } from './daemon-exit-codes'
import { createNoopDaemonFileLog } from './daemon-file-log'
import {
  createStallPoller,
  STALL_WATCHDOG_WORKER_SOURCE,
  DEFAULT_STALL_WATCHDOG_THRESHOLDS,
  startDaemonStallWatchdog,
  type StallWatchdogThresholds
} from './daemon-stall-watchdog'

const MB = 1024 * 1024

describe('stall poller decisions', () => {
  let nowMs = 0
  let beat = 0
  let rss = 100 * MB
  const log = vi.fn()
  const abort = vi.fn()

  function poller(thresholds: Partial<StallWatchdogThresholds> = {}) {
    return createStallPoller({
      readHeartbeat: () => beat,
      now: () => nowMs,
      rss: () => rss,
      cpuMs: () => nowMs,
      log,
      abort,
      exitCode: DAEMON_EXIT_STALL,
      thresholds: { ...DEFAULT_STALL_WATCHDOG_THRESHOLDS, ...thresholds }
    })
  }

  function advance(poll: () => void, ms: number, step = 250): void {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      nowMs += step
      poll()
    }
  }

  beforeEach(() => {
    nowMs = 0
    beat = 0
    rss = 100 * MB
    log.mockReset()
    abort.mockReset()
  })

  it('stays silent while the heartbeat advances', () => {
    const poll = poller()
    for (let i = 0; i < 40; i++) {
      beat += 1
      advance(poll, 250)
    }
    expect(log).not.toHaveBeenCalled()
    expect(abort).not.toHaveBeenCalled()
  })

  it('logs daemon-event-loop-stall once at 1s with rss, then a recovery line when the beat resumes', () => {
    const poll = poller()
    advance(poll, 500)
    expect(log).not.toHaveBeenCalled()
    rss = 150 * MB
    advance(poll, 2_000)
    expect(log.mock.calls.map((call) => call[0])).toEqual(['daemon-event-loop-stall'])
    expect(log.mock.calls[0][1]).toMatchObject({ rss: 150 * MB })
    expect(log.mock.calls[0][1].stalledMs).toBeGreaterThanOrEqual(1_000)
    expect(abort).not.toHaveBeenCalled()
    beat += 1
    advance(poll, 250)
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      'daemon-event-loop-stall',
      'daemon-event-loop-stall-recovered'
    ])
  })

  it('aborts at 6s only when rss grew by 512MB since the stall began', () => {
    const quiet = poller()
    advance(quiet, 10_000)
    expect(abort).not.toHaveBeenCalled()

    nowMs = 0
    beat += 1
    rss = 100 * MB
    log.mockReset()
    const poll = poller()
    poll()
    advance(poll, 5_000)
    rss = 100 * MB + 511 * MB
    advance(poll, 2_000)
    expect(abort).not.toHaveBeenCalled()
    rss = 100 * MB + 512 * MB
    advance(poll, 250)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(abort.mock.calls[0][0]).toMatchObject({ reason: 'rss-growth' })
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      'daemon-event-loop-stall',
      'daemon-stall-abort'
    ])
    expect(log.mock.calls[1][1]).toMatchObject({
      reason: 'rss-growth',
      rssGrowthBytes: 512 * MB,
      exitCode: DAEMON_EXIT_STALL
    })
  })

  it('does not abort a 5s stall even with huge rss growth', () => {
    const poll = poller()
    poll()
    rss = 4_000 * MB
    advance(poll, 5_500)
    expect(abort).not.toHaveBeenCalled()
  })

  it('aborts a 30s stall regardless of rss', () => {
    const poll = poller()
    advance(poll, 29_500)
    expect(abort).not.toHaveBeenCalled()
    advance(poll, 750)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(abort.mock.calls[0][0]).toMatchObject({ reason: 'duration' })
    expect(log.mock.calls.at(-1)?.[0]).toBe('daemon-stall-abort')
    advance(poll, 5_000)
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('treats a long gap between its own polls as a process suspend, not a stall', () => {
    const poll = poller()
    advance(poll, 250)
    nowMs += 3_600_000
    poll()
    expect(abort).not.toHaveBeenCalled()
    expect(log.mock.calls.map((call) => call[0])).toEqual(['daemon-stall-watchdog-resync'])
    advance(poll, 500)
    expect(log.mock.calls.map((call) => call[0])).toEqual(['daemon-stall-watchdog-resync'])
  })
})

describe('daemon stall watchdog worker', () => {
  let dir: string
  let logPath: string
  const stops: (() => void)[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-stall-watchdog-test-'))
    logPath = join(dir, 'daemon.log')
  })

  afterEach(() => {
    for (const stop of stops.splice(0)) {
      stop()
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const testThresholds = (extra: Partial<StallWatchdogThresholds>): StallWatchdogThresholds => ({
    ...DEFAULT_STALL_WATCHDOG_THRESHOLDS,
    heartbeatIntervalMs: 10,
    pollIntervalMs: 10,
    stallLogMs: 100,
    abortStallMs: 60_000,
    abortRssGrowthStallMs: 60_000,
    abortRssGrowthBytes: 4_000 * MB,
    // Why: a loaded host may give the spinning thread well under a full core; the pure poller
    // tests pin the production ratio.
    abortCpuRatio: 0.2,
    resyncGapMs: 10_000,
    ...extra
  })

  const readEvents = (): { event: string; [key: string]: unknown }[] =>
    readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

  function blockMainThread(ms: number): void {
    const start = performance.now()
    while (performance.now() - start < ms) {
      // busy loop: stands in for the unguarded process-tree walk
    }
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the watchdog')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  it('logs the stall and then the abort, in order, for a blocked main thread (abort injected)', async () => {
    const onAbort = vi.fn()
    const watchdog = startDaemonStallWatchdog({
      log: createNoopDaemonFileLog(),
      logFilePath: logPath,
      thresholds: testThresholds({ abortStallMs: 700 }),
      onAbort
    })
    stops.push(watchdog.stop)
    await new Promise((resolve) => setTimeout(resolve, 100))

    blockMainThread(1_500)
    await waitFor(() => onAbort.mock.calls.length > 0)

    const events = readEvents()
    const names = events.map((e) => e.event)
    expect(names.indexOf('daemon-event-loop-stall')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('daemon-event-loop-stall')).toBeLessThan(
      names.indexOf('daemon-stall-abort')
    )
    expect(events[0]).toMatchObject({ src: 'daemon', pid: process.pid })
    expect(events[0].stalledMs as number).toBeGreaterThanOrEqual(100)
    expect(events.at(-1)).toMatchObject({ reason: 'duration', exitCode: DAEMON_EXIT_STALL })
    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(onAbort.mock.calls[0][0]).toMatchObject({ reason: 'duration' })
  })

  it('aborts on rss growth well before the duration limit', async () => {
    const onAbort = vi.fn()
    const watchdog = startDaemonStallWatchdog({
      log: createNoopDaemonFileLog(),
      logFilePath: logPath,
      thresholds: testThresholds({ abortRssGrowthStallMs: 300, abortRssGrowthBytes: 40 * MB }),
      onAbort
    })
    stops.push(watchdog.stop)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const hold: Buffer[] = []
    for (let i = 0; i < 4; i++) {
      hold.push(Buffer.alloc(30 * MB, 1))
    }
    blockMainThread(1_000)
    await waitFor(() => onAbort.mock.calls.length > 0)

    expect(readEvents().map((e) => e.event)).toEqual([
      'daemon-event-loop-stall',
      'daemon-stall-abort'
    ])
    expect(onAbort.mock.calls[0][0]).toMatchObject({ reason: 'rss-growth' })
    expect(hold.length).toBe(4)
  })

  it('logs the stall and the recovery, and never aborts, when the stall is short', async () => {
    const onAbort = vi.fn()
    const watchdog = startDaemonStallWatchdog({
      log: createNoopDaemonFileLog(),
      logFilePath: logPath,
      thresholds: testThresholds({}),
      onAbort
    })
    stops.push(watchdog.stop)
    await new Promise((resolve) => setTimeout(resolve, 100))

    blockMainThread(400)
    await waitFor(() => readEvents().some((e) => e.event === 'daemon-event-loop-stall-recovered'))

    expect(readEvents().map((e) => e.event)).toEqual([
      'daemon-event-loop-stall',
      'daemon-event-loop-stall-recovered'
    ])
    expect(onAbort).not.toHaveBeenCalled()
  })

  it('logs a start line from the main thread', () => {
    const log = { log: vi.fn(), close: vi.fn() }
    const watchdog = startDaemonStallWatchdog({
      log,
      logFilePath: logPath,
      thresholds: testThresholds({}),
      onAbort: vi.fn()
    })
    stops.push(watchdog.stop)
    expect(log.log).toHaveBeenCalledWith('daemon-stall-watchdog-start', expect.any(Object))
  })

  it('production abort ends a stalled process with SIGKILL after logging daemon-stall-abort', () => {
    const script = `
      const { Worker } = require('node:worker_threads')
      const sab = new SharedArrayBuffer(4)
      const hb = new Int32Array(sab)
      setInterval(() => Atomics.add(hb, 0, 1), 10).unref()
      new Worker(process.env.WATCHDOG_SOURCE, {
        eval: true,
        workerData: {
          heartbeat: sab,
          logFilePath: process.env.WATCHDOG_LOG,
          thresholds: JSON.parse(process.env.WATCHDOG_THRESHOLDS),
          exitCode: 21,
          abortMode: 'kill'
        }
      }).unref()
      setTimeout(() => {
        const start = Date.now()
        while (Date.now() - start < 6000) {}
        process.stdout.write('SURVIVED')
      }, 100)
    `
    const result = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        WATCHDOG_SOURCE: STALL_WATCHDOG_WORKER_SOURCE,
        WATCHDOG_LOG: logPath,
        WATCHDOG_THRESHOLDS: JSON.stringify(testThresholds({ abortStallMs: 500 }))
      },
      encoding: 'utf8',
      timeout: 20_000
    })
    expect(result.stdout).not.toContain('SURVIVED')
    // Why: Windows TerminateProcess reports exit status 1 rather than a signal.
    expect(
      result.signal === 'SIGKILL' || (process.platform === 'win32' && result.status === 1)
    ).toBe(true)
    // Why: a stall-blocked line may legitimately interleave on a loaded host, so assert order, not the list.
    const names = readEvents().map((e) => e.event)
    expect(names.indexOf('daemon-event-loop-stall')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('daemon-event-loop-stall')).toBeLessThan(
      names.indexOf('daemon-stall-abort')
    )
    expect(names.at(-1)).toBe('daemon-stall-abort')
    expect(readEvents().at(-1)).toMatchObject({ reason: 'duration', exitCode: DAEMON_EXIT_STALL })
  })
})
