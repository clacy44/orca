import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INACTIVE_TOKEN_KEEPALIVE_FIRST_TICK_MS,
  INACTIVE_TOKEN_KEEPALIVE_INTERVAL_MS,
  startInactiveTokenKeepAlive
} from './inactive-token-keepalive'

const SIX_HOURS = 6 * 60 * 60 * 1000
const FIVE_MINUTES = 5 * 60 * 1000

describe('startInactiveTokenKeepAlive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is a first pass after five minutes, then a six hour cadence', () => {
    expect(INACTIVE_TOKEN_KEEPALIVE_FIRST_TICK_MS).toBe(FIVE_MINUTES)
    expect(INACTIVE_TOKEN_KEEPALIVE_INTERVAL_MS).toBe(SIX_HOURS)
  })

  it('prepares each non-active account five minutes after start, then every six hours', async () => {
    const prepare = vi.fn(async (_id: string) => ({ status: 'ready' }))
    const keepAlive = startInactiveTokenKeepAlive({
      listInactiveAccountIds: () => ['a', 'b'],
      prepare
    })

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 1)
    expect(prepare).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])

    // Nothing more until the six hour interval (counted from start) comes round.
    await vi.advanceTimersByTimeAsync(SIX_HOURS - FIVE_MINUTES - 1)
    expect(prepare).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1)
    expect(prepare).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(SIX_HOURS)
    expect(prepare).toHaveBeenCalledTimes(6)
    keepAlive.stop()
  })

  it('re-reads the account list on every tick', async () => {
    const prepare = vi.fn(async (_id: string) => undefined)
    let ids = ['a']
    const keepAlive = startInactiveTokenKeepAlive({ listInactiveAccountIds: () => ids, prepare })

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES)
    ids = ['b', 'c']
    await vi.advanceTimersByTimeAsync(SIX_HOURS)

    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c'])
    keepAlive.stop()
  })

  it('keeps going past an account whose refresh throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prepare = vi.fn(async (id: string) => {
      if (id === 'a') {
        throw new Error('boom')
      }
    })
    const keepAlive = startInactiveTokenKeepAlive({
      listInactiveAccountIds: () => ['a', 'b'],
      prepare
    })

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES)

    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    keepAlive.stop()
    vi.restoreAllMocks()
  })

  it('does not start a tick while the previous one is still running', async () => {
    let release: () => void = () => {}
    const prepare = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const keepAlive = startInactiveTokenKeepAlive({
      listInactiveAccountIds: () => ['a'],
      prepare,
      intervalMs: 1_000
    })

    await vi.advanceTimersByTimeAsync(3_000)
    expect(prepare).toHaveBeenCalledTimes(1)

    release()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(prepare).toHaveBeenCalledTimes(2)
    release()
    keepAlive.stop()
  })

  it('stop() during a tick lets the in-flight refresh finish but never starts the next account', async () => {
    let finishFirst: () => void = () => {}
    let firstFinished = false
    const prepare = vi.fn(
      (id: string) =>
        new Promise<void>((resolve) => {
          if (id === 'a') {
            finishFirst = () => {
              firstFinished = true
              resolve()
            }
          } else {
            resolve()
          }
        })
    )
    const keepAlive = startInactiveTokenKeepAlive({
      listInactiveAccountIds: () => ['a', 'b'],
      prepare
    })
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES)
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a'])

    keepAlive.stop()
    finishFirst()
    await vi.advanceTimersByTimeAsync(0)

    expect(firstFinished).toBe(true)
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a'])
  })

  it('starts the second account when no stop arrives mid-tick (positive control)', async () => {
    let finishFirst: () => void = () => {}
    const prepare = vi.fn(
      (id: string) =>
        new Promise<void>((resolve) => {
          if (id === 'a') {
            finishFirst = resolve
          } else {
            resolve()
          }
        })
    )
    const keepAlive = startInactiveTokenKeepAlive({
      listInactiveAccountIds: () => ['a', 'b'],
      prepare
    })
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES)

    finishFirst()
    await vi.advanceTimersByTimeAsync(0)

    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    keepAlive.stop()
  })

  it('stops ticking after stop(), including the first pass', async () => {
    const prepare = vi.fn(async (_id: string) => undefined)
    const keepAlive = startInactiveTokenKeepAlive({
      listInactiveAccountIds: () => ['a'],
      prepare
    })
    keepAlive.stop()

    await vi.advanceTimersByTimeAsync(SIX_HOURS * 2)

    expect(prepare).not.toHaveBeenCalled()
  })

  it('unrefs both its timers so they cannot hold the process open', () => {
    const unref = vi.fn()
    const handle = { unref } as unknown as ReturnType<typeof setInterval>
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(handle)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(handle)
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})

    startInactiveTokenKeepAlive({ listInactiveAccountIds: () => [], prepare: async () => {} })

    expect(unref).toHaveBeenCalledTimes(2)
    setIntervalSpy.mockRestore()
    setTimeoutSpy.mockRestore()
    clearIntervalSpy.mockRestore()
    clearTimeoutSpy.mockRestore()
  })
})
