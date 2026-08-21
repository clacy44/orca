import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKeyedTrailingEdgeCoalescer } from './keyed-trailing-edge-coalescer'

describe('createKeyedTrailingEdgeCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function create(emit: (key: string) => void) {
    return createKeyedTrailingEdgeCoalescer(emit, { windowMs: 750, maxWaitMs: 2250 })
  }

  it('settles a burst into one emit at the configured window', () => {
    const emit = vi.fn()
    const coalescer = create(emit)

    for (let index = 0; index < 20; index += 1) {
      coalescer.schedule('pty-1')
      vi.advanceTimersByTime(100)
    }
    expect(emit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(750)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('pty-1')
  })

  it('honours the max-wait cap of ITS options, not the borrowed session-tabs one', () => {
    // Why: the whole point of the extraction is that window and cap are arguments — a wrapper that
    // leaked the 50/250 constants would fire here inside 250ms and pass every other assertion.
    const emit = vi.fn()
    const coalescer = create(emit)

    coalescer.schedule('pty-1')
    for (let elapsed = 0; elapsed < 2250; elapsed += 500) {
      vi.advanceTimersByTime(500)
      coalescer.schedule('pty-1')
    }

    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('keeps per-key windows independent and cancels only the named key', () => {
    const emit = vi.fn()
    const coalescer = create(emit)

    coalescer.schedule('pty-1')
    coalescer.schedule('pty-2')
    coalescer.cancel('pty-1')
    vi.advanceTimersByTime(750)

    expect(emit.mock.calls).toEqual([['pty-2']])
  })

  it('flushes on demand without letting the armed timer double-fire', () => {
    const emit = vi.fn()
    const coalescer = create(emit)

    coalescer.flush('pty-1')
    expect(emit).not.toHaveBeenCalled()

    coalescer.schedule('pty-1')
    coalescer.schedule('pty-2')
    coalescer.flushAll()
    vi.advanceTimersByTime(750)

    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('drops pending timers on dispose without emitting', () => {
    const emit = vi.fn()
    const coalescer = create(emit)

    coalescer.schedule('pty-1')
    coalescer.dispose()
    vi.advanceTimersByTime(750)

    expect(emit).not.toHaveBeenCalled()
  })
})
