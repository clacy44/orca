// G1 F3/F5/F6: the 30s duration abort needs a CPU spin; a blocked syscall only logs. The watchdog
// runs without a log file, and a failed kill is reported.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNoopDaemonFileLog } from './daemon-file-log'
import {
  createStallPoller,
  DEFAULT_STALL_WATCHDOG_THRESHOLDS,
  startDaemonStallWatchdog,
  type StallWatchdogThresholds
} from './daemon-stall-watchdog'

describe('stall poller CPU gate on the duration abort', () => {
  let nowMs = 0
  let cpuMs = 0
  const log = vi.fn()
  const abort = vi.fn()

  const poller = () =>
    createStallPoller({
      readHeartbeat: () => 0,
      now: () => nowMs,
      rss: () => 0,
      cpuMs: () => cpuMs,
      log,
      abort,
      exitCode: 21,
      thresholds: DEFAULT_STALL_WATCHDOG_THRESHOLDS
    })

  function run(poll: () => void, ms: number, cpuPerWallMs: number): void {
    for (let elapsed = 0; elapsed < ms; elapsed += 250) {
      nowMs += 250
      cpuMs += 250 * cpuPerWallMs
      poll()
    }
  }

  beforeEach(() => {
    nowMs = 0
    cpuMs = 0
    log.mockReset()
    abort.mockReset()
  })

  it('aborts a 30s CPU spin', () => {
    const poll = poller()
    run(poll, 31_000, 1)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(abort.mock.calls[0][0]).toMatchObject({ reason: 'duration' })
  })

  it('does not abort a 30s stall with no CPU growth, and logs daemon-event-loop-stall-blocked rate-limited', () => {
    const poll = poller()
    run(poll, 65_000, 0)
    expect(abort).not.toHaveBeenCalled()
    const blocked = log.mock.calls.filter((c) => c[0] === 'daemon-event-loop-stall-blocked')
    expect(blocked.length).toBeGreaterThanOrEqual(2)
    expect(blocked.length).toBeLessThanOrEqual(3)
    expect(blocked[0][1]).toMatchObject({ cpuGrowthMs: 0 })
    expect(log.mock.calls.some((c) => c[0] === 'daemon-stall-abort')).toBe(false)
  })

  it('needs CPU growth of at least 0.8x the stall duration', () => {
    const slow = poller()
    run(slow, 31_000, 0.79)
    expect(abort).not.toHaveBeenCalled()

    nowMs = 0
    cpuMs = 0
    log.mockReset()
    const fast = poller()
    run(fast, 31_000, 0.8)
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('leaves the rss-growth rule independent of CPU', () => {
    let rss = 100
    const poll = createStallPoller({
      readHeartbeat: () => 0,
      now: () => nowMs,
      rss: () => rss,
      cpuMs: () => 0,
      log,
      abort,
      exitCode: 21,
      thresholds: DEFAULT_STALL_WATCHDOG_THRESHOLDS
    })
    for (let i = 0; i < 30; i++) {
      nowMs += 250
      rss += 100 * 1024 * 1024
      poll()
    }
    expect(abort.mock.calls[0]?.[0]).toMatchObject({ reason: 'rss-growth' })
  })
})

describe('daemon stall watchdog worker (CPU gate, no log file, failed kill)', () => {
  let dir: string
  let logPath: string
  const stops: (() => void)[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-stall-watchdog-cpu-'))
    logPath = join(dir, 'daemon.log')
  })
  afterEach(() => {
    for (const stop of stops.splice(0)) {
      stop()
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const thresholds = (extra: Partial<StallWatchdogThresholds>): StallWatchdogThresholds => ({
    ...DEFAULT_STALL_WATCHDOG_THRESHOLDS,
    heartbeatIntervalMs: 10,
    pollIntervalMs: 10,
    stallLogMs: 100,
    abortStallMs: 500,
    abortRssGrowthStallMs: 60_000,
    abortRssGrowthBytes: 4_000 * 1024 * 1024,
    resyncGapMs: 10_000,
    ...extra
  })
  const events = (): { event: string; [k: string]: unknown }[] =>
    readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  const spin = (ms: number): void => {
    const start = performance.now()
    while (performance.now() - start < ms) {
      // busy loop
    }
  }
  async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error('timed out')
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('does not abort a sleep-like block (no CPU) but logs it as blocked', async () => {
    const onAbort = vi.fn()
    stops.push(
      startDaemonStallWatchdog({
        log: createNoopDaemonFileLog(),
        logFilePath: logPath,
        thresholds: thresholds({}),
        onAbort
      }).stop
    )
    await new Promise((r) => setTimeout(r, 100))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200)
    await waitFor(() => events().some((e) => e.event === 'daemon-event-loop-stall-recovered'))
    const names = events().map((e) => e.event)
    expect(names).toContain('daemon-event-loop-stall-blocked')
    expect(names).not.toContain('daemon-stall-abort')
    expect(onAbort).not.toHaveBeenCalled()
  })

  it('aborts a CPU spin of the same length', async () => {
    const onAbort = vi.fn()
    stops.push(
      startDaemonStallWatchdog({
        log: createNoopDaemonFileLog(),
        logFilePath: logPath,
        thresholds: thresholds({}),
        onAbort
      }).stop
    )
    await new Promise((r) => setTimeout(r, 100))
    spin(1_500)
    await waitFor(() => onAbort.mock.calls.length > 0)
    expect(onAbort.mock.calls[0][0]).toMatchObject({ reason: 'duration' })
  })

  it('still aborts when there is no log file (logging is a no-op)', async () => {
    const onAbort = vi.fn()
    stops.push(
      startDaemonStallWatchdog({
        log: createNoopDaemonFileLog(),
        thresholds: thresholds({}),
        onAbort
      }).stop
    )
    await new Promise((r) => setTimeout(r, 100))
    spin(1_500)
    await waitFor(() => onAbort.mock.calls.length > 0)
    expect(onAbort).toHaveBeenCalledTimes(1)
  })

  it('logs daemon-stall-abort-failed when the kill throws', async () => {
    stops.push(
      startDaemonStallWatchdog({
        log: createNoopDaemonFileLog(),
        logFilePath: logPath,
        thresholds: thresholds({}),
        killPid: 2_147_483_646
      }).stop
    )
    await new Promise((r) => setTimeout(r, 100))
    spin(1_500)
    await waitFor(() => events().some((e) => e.event === 'daemon-stall-abort-failed'))
    const names = events().map((e) => e.event)
    expect(names.indexOf('daemon-stall-abort')).toBeLessThan(
      names.indexOf('daemon-stall-abort-failed')
    )
  })
})
