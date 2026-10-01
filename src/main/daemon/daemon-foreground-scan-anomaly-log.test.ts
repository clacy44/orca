import { describe, expect, it, vi } from 'vitest'
import { createForegroundScanAnomalyLog } from './daemon-foreground-scan-anomaly-log'

describe('createForegroundScanAnomalyLog', () => {
  it('writes foreground-scan-stale-ppid once per session per 10 minutes, counts only', () => {
    const log = { log: vi.fn(), close: vi.fn() }
    let now = 0
    const report = createForegroundScanAnomalyLog(log, () => now)
    const anomaly = { staleEdgesSkipped: 2, rowCount: 300, descendantCount: 4, fresh: true }

    report('pty-session-abcdef0123456789', anomaly)
    report('pty-session-abcdef0123456789', anomaly)
    report('pty-session-other', anomaly)
    now += 10 * 60_000
    report('pty-session-abcdef0123456789', anomaly)

    expect(log.log).toHaveBeenCalledTimes(3)
    expect(log.log.mock.calls[0]).toEqual([
      'foreground-scan-stale-ppid',
      {
        sessionIdSuffix: 'cdef0123456789'.slice(-10),
        staleEdgesSkipped: 2,
        rowCount: 300,
        descendantCount: 4,
        fresh: true
      }
    ])
    expect(log.log.mock.calls[2][1]).toMatchObject({ suppressed: 1 })
    expect(Object.keys(log.log.mock.calls[0][1]).sort()).toEqual([
      'descendantCount',
      'fresh',
      'rowCount',
      'sessionIdSuffix',
      'staleEdgesSkipped'
    ])
  })
})
