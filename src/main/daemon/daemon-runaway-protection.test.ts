import { afterEach, describe, expect, it, vi } from 'vitest'
import { DAEMON_EXIT_HEAP_PRESSURE } from './daemon-exit-codes'
import { createDaemonRunawayProtection } from './daemon-runaway-protection'

describe('createDaemonRunawayProtection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('routes foreground scan anomalies for a session into daemon.log', () => {
    const log = { log: vi.fn(), close: vi.fn() }
    const protection = createDaemonRunawayProtection(log, undefined)
    protection.foregroundScanAnomalyFor('pty-session-0123456789')({
      staleEdgesSkipped: 1,
      rowCount: 10,
      descendantCount: 2,
      fresh: false
    })
    expect(log.log).toHaveBeenCalledWith(
      'foreground-scan-stale-ppid',
      expect.objectContaining({ sessionIdSuffix: 'session-0123456789'.slice(-10) })
    )
  })

  it('closes the log and exits with the heap-pressure code', () => {
    const log = { log: vi.fn(), close: vi.fn() }
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    createDaemonRunawayProtection(log, undefined).onHeapPressureExit()
    expect(log.close).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(DAEMON_EXIT_HEAP_PRESSURE)
  })

  it('does not start a watchdog worker without a log file path', () => {
    const log = { log: vi.fn(), close: vi.fn() }
    createDaemonRunawayProtection(log, undefined).startStallWatchdog()
    expect(log.log).not.toHaveBeenCalled()
  })
})
