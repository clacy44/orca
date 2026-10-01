/**
 * D-26b W2: async heap growth with a live event loop (R314). Every 5s compare v8 used heap against
 * heap_size_limit: 50% logs attribution, 70% sheds, 85% logs and exits so the death is attributed
 * and early instead of an anonymous OOM abort. A synchronous runaway is the stall watchdog's job.
 */
import type { Socket } from 'node:net'
import { memoryUsage } from 'node:process'
import { getHeapStatistics } from 'node:v8'
import type { DaemonFileLog } from './daemon-file-log'

export const HEAP_PRESSURE_CHECK_INTERVAL_MS = 5_000
export const HEAP_PRESSURE_LOG_RATIO = 0.5
export const HEAP_PRESSURE_SHED_RATIO = 0.7
export const HEAP_PRESSURE_EXIT_RATIO = 0.85
const PRESSURE_LOG_MIN_GAP_MS = 30_000
const SHED_LOG_MIN_GAP_MS = 30_000
const MAX_ATTRIBUTION_ENTRIES = 8

export type HeapPressureClientAttribution = {
  clientId: string
  streamWritableLength: number
  controlWritableLength: number
  batcherQueuedChars: number
}

export type HeapPressureSessionAttribution = { sessionId: string; pendingOutputBytes: number }

export type HeapPressureAttribution = {
  clients: HeapPressureClientAttribution[]
  sessions: HeapPressureSessionAttribution[]
}

export type HeapShedOutcome = {
  batcherSessions: number
  batcherDroppedChars: number
  pendingSessionsOverflowed: number
  socketsDestroyed: number
}

export type DaemonHeapPressureGuardOptions = {
  log: DaemonFileLog
  describe: () => HeapPressureAttribution
  shed: () => HeapShedOutcome
  /** Called after daemon_heap_exit is logged; production ends the process. */
  exit: () => void
  readHeapStats?: () => { usedHeapBytes: number; heapLimitBytes: number }
  readRss?: () => number
  intervalMs?: number
  now?: () => number
}

export type DaemonHeapPressureGuard = { check: () => void; stop: () => void }

function readV8HeapStats(): { usedHeapBytes: number; heapLimitBytes: number } {
  const stats = getHeapStatistics()
  return { usedHeapBytes: stats.used_heap_size, heapLimitBytes: stats.heap_size_limit }
}

function topBy<T>(entries: T[], size: (entry: T) => number): T[] {
  return entries
    .filter((entry) => size(entry) > 0)
    .sort((a, b) => size(b) - size(a))
    .slice(0, MAX_ATTRIBUTION_ENTRIES)
}

function attributionFields(attribution: HeapPressureAttribution): Record<string, unknown> {
  return {
    clients: topBy(
      attribution.clients,
      (c) => c.streamWritableLength + c.controlWritableLength + c.batcherQueuedChars
    ),
    sessions: topBy(attribution.sessions, (s) => s.pendingOutputBytes).map((s) => ({
      sessionIdSuffix: s.sessionId.slice(-10),
      pendingOutputBytes: s.pendingOutputBytes
    }))
  }
}

/** Destroys any control or stream socket whose own write buffer is past the ceiling; the client reconnects. */
export function destroyOverdeepSockets(
  clients: Iterable<{ controlSocket: Socket; streamSocket: Socket | null }>,
  ceilingBytes: number
): number {
  let destroyed = 0
  for (const client of clients) {
    for (const socket of [client.controlSocket, client.streamSocket]) {
      if (socket && !socket.destroyed && (socket.writableLength ?? 0) > ceilingBytes) {
        socket.destroy()
        destroyed += 1
      }
    }
  }
  return destroyed
}

export function startDaemonHeapPressureGuard(
  opts: DaemonHeapPressureGuardOptions
): DaemonHeapPressureGuard {
  const readHeapStats = opts.readHeapStats ?? readV8HeapStats
  const readRss = opts.readRss ?? ((): number => memoryUsage().rss)
  const now = opts.now ?? Date.now
  let lastPressureLogAt = Number.NEGATIVE_INFINITY
  let lastShedLogAt = Number.NEGATIVE_INFINITY
  let shedPassesSinceLog = 0
  let exiting = false
  let timer: ReturnType<typeof setInterval> | null = null

  const stop = (): void => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const check = (): void => {
    if (exiting) {
      return
    }
    const { usedHeapBytes, heapLimitBytes } = readHeapStats()
    const ratio = heapLimitBytes > 0 ? usedHeapBytes / heapLimitBytes : 0
    if (ratio < HEAP_PRESSURE_LOG_RATIO) {
      return
    }
    const base = {
      heapUsed: usedHeapBytes,
      heapLimit: heapLimitBytes,
      ratio: Math.round(ratio * 1000) / 1000,
      rss: readRss()
    }
    const attribution = attributionFields(opts.describe())
    if (ratio >= HEAP_PRESSURE_EXIT_RATIO) {
      exiting = true
      stop()
      opts.log.log('daemon_heap_exit', { ...base, ...attribution })
      opts.exit()
      return
    }
    const at = now()
    if (at - lastPressureLogAt >= PRESSURE_LOG_MIN_GAP_MS) {
      lastPressureLogAt = at
      opts.log.log('daemon_heap_pressure', { ...base, ...attribution })
    }
    if (ratio >= HEAP_PRESSURE_SHED_RATIO) {
      const outcome = opts.shed()
      shedPassesSinceLog += 1
      if (at - lastShedLogAt >= SHED_LOG_MIN_GAP_MS) {
        lastShedLogAt = at
        opts.log.log('daemon_heap_shed', { ...base, ...outcome, shedPasses: shedPassesSinceLog })
        shedPassesSinceLog = 0
      }
    }
  }

  timer = setInterval(check, opts.intervalMs ?? HEAP_PRESSURE_CHECK_INTERVAL_MS)
  timer.unref?.()
  return { check, stop }
}
