/**
 * D-26b W1: off-main-thread stall watchdog. A synchronous runaway (R314) never returns to the main
 * event loop, so no main-thread timer can see or end it. The main thread bumps a SharedArrayBuffer
 * heartbeat; a Worker polls it, logs a stall, and ends the process when the stall is a runaway
 * (>=6s with >=512MB rss growth since the stall began) or a >=30s CPU spin. A 30s stall that burns
 * no CPU (a blocked syscall) is only logged: it is not the runaway and may still recover.
 *
 * The worker cannot set the process exit code (worker process.exit ends only the worker), so the
 * production abort is SIGKILL after daemon-stall-abort is logged; the line carries DAEMON_EXIT_STALL.
 */
import { Worker } from 'node:worker_threads'
import { DAEMON_EXIT_STALL } from './daemon-exit-codes'
import type { DaemonFileLog } from './daemon-file-log'

export type StallWatchdogThresholds = {
  heartbeatIntervalMs: number
  pollIntervalMs: number
  stallLogMs: number
  abortStallMs: number
  abortRssGrowthStallMs: number
  abortRssGrowthBytes: number
  /** The duration abort also needs process CPU time to grow by this fraction of the stall's wall time. */
  abortCpuRatio: number
  blockedLogIntervalMs: number
  /** A gap this long between the worker's own polls means the whole process was suspended, not stalled. */
  resyncGapMs: number
}

export const DEFAULT_STALL_WATCHDOG_THRESHOLDS: StallWatchdogThresholds = {
  heartbeatIntervalMs: 250,
  pollIntervalMs: 250,
  stallLogMs: 1_000,
  abortStallMs: 30_000,
  abortRssGrowthStallMs: 6_000,
  abortRssGrowthBytes: 512 * 1024 * 1024,
  abortCpuRatio: 0.8,
  blockedLogIntervalMs: 30_000,
  resyncGapMs: 2_000
}

export type StallAbortInfo = {
  reason: 'duration' | 'rss-growth'
  stalledMs: number
  rss: number
  rssGrowthBytes: number
  cpuGrowthMs: number
}

export type StallPollerEnv = {
  readHeartbeat: () => number
  now: () => number
  rss: () => number
  /** Process-wide CPU time (user + system) in ms; a main-thread spin shows up here from the worker. */
  cpuMs: () => number
  log: (event: string, details: Record<string, unknown>) => void
  abort: (info: StallAbortInfo) => void
  exitCode: number
  thresholds: StallWatchdogThresholds
}

// Why: self-contained on purpose — the worker is built from this function's source text, so it
// may reference nothing outside its own parameters.
export function createStallPoller(env: StallPollerEnv): () => void {
  const { thresholds } = env
  let lastBeat = env.readHeartbeat()
  let lastBeatAt = env.now()
  let lastPollAt = lastBeatAt
  let healthyRss = env.rss()
  let healthyCpuMs = env.cpuMs()
  let lastBlockedLogAt = Number.NEGATIVE_INFINITY
  let stallLogged = false
  let aborted = false
  return () => {
    if (aborted) {
      return
    }
    const at = env.now()
    const gapMs = at - lastPollAt
    lastPollAt = at
    if (gapMs > thresholds.resyncGapMs) {
      env.log('daemon-stall-watchdog-resync', { gapMs: Math.round(gapMs) })
      lastBeat = env.readHeartbeat()
      lastBeatAt = at
      healthyRss = env.rss()
      healthyCpuMs = env.cpuMs()
      stallLogged = false
      return
    }
    const beat = env.readHeartbeat()
    if (beat !== lastBeat) {
      const rss = env.rss()
      if (stallLogged) {
        env.log('daemon-event-loop-stall-recovered', {
          stalledMs: Math.round(at - lastBeatAt),
          rss
        })
      }
      lastBeat = beat
      lastBeatAt = at
      healthyRss = rss
      healthyCpuMs = env.cpuMs()
      stallLogged = false
      return
    }
    const stalledMs = at - lastBeatAt
    if (stalledMs < thresholds.stallLogMs) {
      return
    }
    const rss = env.rss()
    if (!stallLogged) {
      stallLogged = true
      env.log('daemon-event-loop-stall', { stalledMs: Math.round(stalledMs), rss })
    }
    const rssGrowthBytes = rss - healthyRss
    const cpuGrowthMs = env.cpuMs() - healthyCpuMs
    const longEnough = stalledMs >= thresholds.abortStallMs
    const spinning = cpuGrowthMs >= thresholds.abortCpuRatio * stalledMs
    if (longEnough && !spinning && at - lastBlockedLogAt >= thresholds.blockedLogIntervalMs) {
      lastBlockedLogAt = at
      env.log('daemon-event-loop-stall-blocked', {
        stalledMs: Math.round(stalledMs),
        cpuGrowthMs: Math.round(cpuGrowthMs),
        rss
      })
    }
    const reason =
      longEnough && spinning
        ? 'duration'
        : stalledMs >= thresholds.abortRssGrowthStallMs &&
            rssGrowthBytes >= thresholds.abortRssGrowthBytes
          ? 'rss-growth'
          : null
    if (reason === null) {
      return
    }
    aborted = true
    const info: StallAbortInfo = {
      reason,
      stalledMs: Math.round(stalledMs),
      rss,
      rssGrowthBytes,
      cpuGrowthMs: Math.round(cpuGrowthMs)
    }
    env.log('daemon-stall-abort', { ...info, exitCode: env.exitCode })
    env.abort(info)
  }
}

export const STALL_WATCHDOG_WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads')
const { appendFileSync } = require('node:fs')
const { performance } = require('node:perf_hooks')
const createStallPoller = ${createStallPoller.toString()}
const heartbeat = new Int32Array(workerData.heartbeat)
const log = (event, details) => {
  if (!workerData.logFilePath) return
  try {
    const line = { src: 'daemon', ts: new Date().toISOString(), pid: process.pid, event, ...details }
    appendFileSync(workerData.logFilePath, JSON.stringify(line) + '\\n', { mode: 0o600 })
  } catch {}
}
let timer = null
const poll = createStallPoller({
  readHeartbeat: () => Atomics.load(heartbeat, 0),
  now: () => performance.now(),
  rss: () => process.memoryUsage.rss(),
  cpuMs: () => { const usage = process.cpuUsage(); return (usage.user + usage.system) / 1000 },
  log,
  exitCode: workerData.exitCode,
  thresholds: workerData.thresholds,
  abort: (info) => {
    clearInterval(timer)
    if (workerData.abortMode === 'kill') {
      try {
        process.kill(workerData.killPid || process.pid, 'SIGKILL')
      } catch (error) {
        log('daemon-stall-abort-failed', { message: String(error && error.message) })
      }
    }
    parentPort.postMessage({ type: 'abort', info })
  }
})
timer = setInterval(poll, workerData.thresholds.pollIntervalMs)
`

export type DaemonStallWatchdogOptions = {
  log: DaemonFileLog
  /** Absent when the daemon has no log file: the worker's logging becomes a no-op, the abort stays. */
  logFilePath?: string
  thresholds?: Partial<StallWatchdogThresholds>
  /** Test seam: replaces the SIGKILL so the abort path can run without ending the process. */
  onAbort?: (info: StallAbortInfo) => void
  /** Test seam: the pid the production abort signals (always this process otherwise). */
  killPid?: number
}

export function startDaemonStallWatchdog(opts: DaemonStallWatchdogOptions): { stop: () => void } {
  const thresholds = { ...DEFAULT_STALL_WATCHDOG_THRESHOLDS, ...opts.thresholds }
  const heartbeatBuffer = new SharedArrayBuffer(4)
  const heartbeat = new Int32Array(heartbeatBuffer)
  let worker: Worker
  try {
    worker = new Worker(STALL_WATCHDOG_WORKER_SOURCE, {
      eval: true,
      workerData: {
        heartbeat: heartbeatBuffer,
        logFilePath: opts.logFilePath ?? '',
        ...(opts.killPid === undefined ? {} : { killPid: opts.killPid }),
        thresholds,
        exitCode: DAEMON_EXIT_STALL,
        abortMode: opts.onAbort ? 'message' : 'kill'
      },
      resourceLimits: { maxOldGenerationSizeMb: 32 }
    })
  } catch (error) {
    opts.log.log('daemon-stall-watchdog-unavailable', {
      message: error instanceof Error ? error.message : String(error)
    })
    return { stop: () => {} }
  }
  worker.unref()
  worker.on('message', (message: { type?: string; info?: StallAbortInfo }) => {
    if (message?.type === 'abort' && message.info) {
      opts.onAbort?.(message.info)
    }
  })
  worker.on('error', (error: Error) => {
    opts.log.log('daemon-stall-watchdog-error', { message: error.message })
  })
  let stopping = false
  worker.on('exit', (code) => {
    if (!stopping) {
      opts.log.log('daemon-stall-watchdog-stopped', { code })
    }
  })
  const timer = setInterval(() => Atomics.add(heartbeat, 0, 1), thresholds.heartbeatIntervalMs)
  timer.unref()
  opts.log.log('daemon-stall-watchdog-start', {
    stallLogMs: thresholds.stallLogMs,
    abortStallMs: thresholds.abortStallMs,
    abortRssGrowthStallMs: thresholds.abortRssGrowthStallMs,
    abortRssGrowthBytes: thresholds.abortRssGrowthBytes
  })
  return {
    stop: () => {
      stopping = true
      clearInterval(timer)
      void worker.terminate()
    }
  }
}
