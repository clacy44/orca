import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INACTIVE_TOKEN_KEEPALIVE_INTERVAL_MS,
  startInactiveTokenKeepAlive
} from './inactive-token-keepalive'

const SIX_HOURS = 6 * 60 * 60 * 1000

describe('startInactiveTokenKeepAlive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is a six hour cadence', () => {
    expect(INACTIVE_TOKEN_KEEPALIVE_INTERVAL_MS).toBe(SIX_HOURS)
  })

  it('prepares each non-active account every six hours and not before', async () => {
    const prepare = vi.fn(async (_id: string) => ({ status: 'ready' }))
    const keepAlive = startInactiveTokenKeepAlive({
      listInactiveAccountIds: () => ['a', 'b'],
      prepare
    })

    await vi.advanceTimersByTimeAsync(SIX_HOURS - 1)
    expect(prepare).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])

    await vi.advanceTimersByTimeAsync(SIX_HOURS)
    expect(prepare).toHaveBeenCalledTimes(4)
    keepAlive.stop()
  })

  it('re-reads the account list on every tick', async () => {
    const prepare = vi.fn(async (_id: string) => undefined)
    let ids = ['a']
    const keepAlive = startInactiveTokenKeepAlive({ listInactiveAccountIds: () => ids, prepare })

    await vi.advanceTimersByTimeAsync(SIX_HOURS)
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

    await vi.advanceTimersByTimeAsync(SIX_HOURS)

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

  it('stops ticking after stop()', async () => {
    const prepare = vi.fn(async (_id: string) => undefined)
    const keepAlive = startInactiveTokenKeepAlive({
      listInactiveAccountIds: () => ['a'],
      prepare
    })
    keepAlive.stop()

    await vi.advanceTimersByTimeAsync(SIX_HOURS * 2)

    expect(prepare).not.toHaveBeenCalled()
  })

  it('unrefs its timer so it cannot hold the process open', () => {
    const unref = vi.fn()
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>)
    const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})

    startInactiveTokenKeepAlive({ listInactiveAccountIds: () => [], prepare: async () => {} })

    expect(unref).toHaveBeenCalledTimes(1)
    setIntervalSpy.mockRestore()
    clearSpy.mockRestore()
  })
})
