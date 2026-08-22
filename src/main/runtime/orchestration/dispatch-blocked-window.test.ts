import { describe, expect, it } from 'vitest'
import {
  DISPATCH_BLOCKED_EXEMPTION_CAP_MS,
  evaluateDispatchLiveness,
  whileDispatchBlocked
} from './dispatch-blocked-window'

const MIN = 60 * 1000
const NOW = Date.parse('2026-08-22T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('evaluateDispatchLiveness', () => {
  // Why this is the headline of A1 §14: the preamble tells a worker to stop heartbeating inside
  // `ask`, so without the exemption the best-behaved worker is the first one a window kills.
  it('does not breach a 15-minute window for a worker parked in ask for 20 minutes', () => {
    const verdict = evaluateDispatchLiveness({
      lastHeartbeatAt: ago(21 * MIN),
      blockedSince: ago(20 * MIN),
      windowMs: 15 * MIN,
      now: NOW
    })

    expect(verdict.breached).toBe(false)
    expect(verdict.silenceMs).toBe(21 * MIN)
    expect(verdict.exemptedMs).toBe(20 * MIN)
    expect(verdict.effectiveSilenceMs).toBe(1 * MIN)
  })

  // Why paired with the case above: without this, a broken evaluator that never breaches passes.
  it('breaches the same window for the same silence with no park recorded', () => {
    expect(
      evaluateDispatchLiveness({
        lastHeartbeatAt: ago(21 * MIN),
        windowMs: 15 * MIN,
        now: NOW
      })
    ).toMatchObject({ breached: true, exemptedMs: 0, effectiveSilenceMs: 21 * MIN })
  })

  it('does not breach for a worker heartbeating on the 5-minute cadence', () => {
    expect(
      evaluateDispatchLiveness({
        lastHeartbeatAt: ago(5 * MIN),
        windowMs: 15 * MIN,
        now: NOW
      })
    ).toMatchObject({ breached: false })
  })

  it('measures a never-heartbeated Dispatch from its space-format dispatched_at', () => {
    expect(
      evaluateDispatchLiveness({
        lastHeartbeatAt: null,
        dispatchedAt: '2026-08-22 11:40:00',
        windowMs: 15 * MIN,
        now: NOW
      })
    ).toMatchObject({ breached: true, silenceMs: 20 * MIN })
  })

  it('reports no age at all rather than an age of zero when nothing is stamped', () => {
    expect(evaluateDispatchLiveness({ windowMs: 15 * MIN, now: NOW })).toEqual({ breached: false })
    expect(
      evaluateDispatchLiveness({ lastHeartbeatAt: 'a while ago', windowMs: 15 * MIN, now: NOW })
    ).toEqual({ breached: false })
  })

  it('treats a zero or non-finite window as the reserved disable', () => {
    const silent = { lastHeartbeatAt: ago(4 * 60 * MIN), now: NOW }
    expect(evaluateDispatchLiveness({ ...silent, windowMs: 0 }).breached).toBe(false)
    expect(evaluateDispatchLiveness({ ...silent, windowMs: Number.NaN }).breached).toBe(false)
  })

  // Why: the marker is durable, so a restart mid-park leaves it set with nothing to clear it.
  // A leaked marker must delay a breach, never suppress one.
  it('caps a marker left behind by a restart so a worker that died parked still breaches', () => {
    const verdict = evaluateDispatchLiveness({
      lastHeartbeatAt: ago(120 * MIN),
      blockedSince: ago(200 * MIN),
      windowMs: 15 * MIN,
      now: NOW
    })

    expect(verdict.exemptedMs).toBe(DISPATCH_BLOCKED_EXEMPTION_CAP_MS)
    expect(verdict.effectiveSilenceMs).toBe(120 * MIN - DISPATCH_BLOCKED_EXEMPTION_CAP_MS)
    expect(verdict.breached).toBe(true)
  })

  // Why the overlap and not the whole park: only silence that ran alongside the park was ever
  // charged to the worker, so a park that predates the last heartbeat gives back only the tail.
  it('exempts only the part of the park that overlapped the silence', () => {
    expect(
      evaluateDispatchLiveness({
        lastHeartbeatAt: ago(10 * MIN),
        blockedSince: ago(40 * MIN),
        windowMs: 15 * MIN,
        now: NOW
      })
    ).toMatchObject({ silenceMs: 10 * MIN, exemptedMs: 10 * MIN, effectiveSilenceMs: 0 })
  })

  it('ignores a park stamp that has not happened yet', () => {
    expect(
      evaluateDispatchLiveness({
        lastHeartbeatAt: ago(30 * MIN),
        blockedSince: new Date(NOW + 5 * MIN).toISOString(),
        windowMs: 15 * MIN,
        now: NOW
      })
    ).toMatchObject({ breached: true, exemptedMs: 0 })
  })
})

describe('whileDispatchBlocked', () => {
  function recordingStore() {
    const calls: string[] = []
    return {
      calls,
      markDispatchBlocked: (dispatchId: string) => calls.push(`mark:${dispatchId}`),
      clearDispatchBlocked: (dispatchId: string) => calls.push(`clear:${dispatchId}`)
    }
  }

  it('marks before the park and clears after it', async () => {
    const store = recordingStore()

    await whileDispatchBlocked(store, 'ctx_1', async () => {
      expect(store.calls).toEqual(['mark:ctx_1'])
      return 'notified'
    })

    expect(store.calls).toEqual(['mark:ctx_1', 'clear:ctx_1'])
  })

  it('clears the same Dispatch it marked when the park throws', async () => {
    const store = recordingStore()

    await expect(
      whileDispatchBlocked(store, 'ctx_1', () => Promise.reject(new Error('socket closed')))
    ).rejects.toThrow('socket closed')

    expect(store.calls).toEqual(['mark:ctx_1', 'clear:ctx_1'])
  })

  // Why: identity resolution is best-effort in the SSH-remote, WSL and remote-run-mailbox shapes.
  it('parks without a marker when no Dispatch identity resolved', async () => {
    const store = recordingStore()

    await expect(whileDispatchBlocked(store, undefined, async () => 'notified')).resolves.toBe(
      'notified'
    )
    expect(store.calls).toEqual([])
  })

  it('never fails the verb when the marker write throws', async () => {
    const store = {
      markDispatchBlocked: () => {
        throw new Error('database is locked')
      },
      clearDispatchBlocked: () => {
        throw new Error('database is locked')
      }
    }

    await expect(whileDispatchBlocked(store, 'ctx_1', async () => 'notified')).resolves.toBe(
      'notified'
    )
  })
})
