import { describe, expect, it, vi } from 'vitest'
import { createRateLimitedEventLog } from './daemon-rate-limited-event-log'

describe('createRateLimitedEventLog', () => {
  it('logs once per key per interval and reports swallowed lines on the next one', () => {
    const log = { log: vi.fn(), close: vi.fn() }
    let now = 1_000
    const emit = createRateLimitedEventLog(log, 'x-event', 600_000, () => now)

    emit('a', { n: 1 })
    emit('a', { n: 2 })
    emit('b', { n: 3 })
    now += 599_999
    emit('a', { n: 4 })
    now += 1
    emit('a', { n: 5 })

    expect(log.log.mock.calls).toEqual([
      ['x-event', { n: 1 }],
      ['x-event', { n: 3 }],
      ['x-event', { n: 5, suppressed: 2 }]
    ])
  })

  it('bounds the number of tracked keys', () => {
    const log = { log: vi.fn(), close: vi.fn() }
    const emit = createRateLimitedEventLog(log, 'x-event', 600_000, () => 5)
    for (let i = 0; i < 1000; i++) {
      emit(`k${i}`)
    }
    expect(log.log).toHaveBeenCalledTimes(1000)
  })
})
