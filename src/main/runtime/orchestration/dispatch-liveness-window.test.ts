import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_ASK_MAX_TIMEOUT_MS } from '../../../shared/orchestration-ask-timeout'
import {
  DISPATCH_LIVENESS_DEFAULT_WINDOW_MS,
  resolveDispatchLivenessWindowMs,
  selectDispatchLivenessBreaches,
  type DispatchLivenessCandidateRow
} from './dispatch-liveness-window'

const MINUTE_MS = 60_000
const NOW = Date.parse('2026-08-22T12:00:00.000Z')

function candidate(overrides: Partial<DispatchLivenessCandidateRow> = {}) {
  return {
    id: 'ctx_1',
    run_id: 'run_1',
    task_id: 'task_1',
    dispatched_at: new Date(NOW - 90 * MINUTE_MS).toISOString(),
    last_heartbeat_at: null,
    blocked_since: null,
    start_options: '{}',
    ...overrides
  } satisfies DispatchLivenessCandidateRow
}

describe('dispatch liveness window', () => {
  it('defaults to the longest legal ask so a fully parked worker cannot breach', () => {
    expect(DISPATCH_LIVENESS_DEFAULT_WINDOW_MS).toBe(ORCHESTRATION_ASK_MAX_TIMEOUT_MS)
  })

  it.each([
    ['an absent blob', null],
    ['an empty blob', '{}'],
    ['a blob that is not JSON', 'not json'],
    ['a non-numeric value', '{"livenessWindowMs":"30m"}'],
    ['a negative value', '{"livenessWindowMs":-1}']
  ])('falls back to the default window for %s', (_label, startOptions) => {
    expect(resolveDispatchLivenessWindowMs(startOptions)).toBe(DISPATCH_LIVENESS_DEFAULT_WINDOW_MS)
  })

  it('keeps 0 as the explicit disable rather than treating it as missing', () => {
    expect(resolveDispatchLivenessWindowMs('{"livenessWindowMs":0}')).toBe(0)
    expect(
      selectDispatchLivenessBreaches([candidate({ start_options: '{"livenessWindowMs":0}' })], NOW)
    ).toEqual([])
  })

  it('ages a Dispatch that never heartbeated from its dispatch, reporting no heartbeat', () => {
    expect(selectDispatchLivenessBreaches([candidate()], NOW)).toEqual([
      {
        dispatchId: 'ctx_1',
        runId: 'run_1',
        taskId: 'task_1',
        lastHeartbeatAt: null,
        windowMs: DISPATCH_LIVENESS_DEFAULT_WINDOW_MS,
        silenceMs: 90 * MINUTE_MS,
        effectiveSilenceMs: 90 * MINUTE_MS
      }
    ])
  })

  // Why both formats: last_heartbeat_at is written as SQLite's timezone-less space format on one
  // path and as offset-bearing ISO on the other, and reading the space format as local time would
  // hand a worker in a non-UTC runtime a window hours wide or hours short.
  it.each([
    ['the SQLite space format', '2026-08-22 11:20:00'],
    ['the ISO format', '2026-08-22T11:20:00.000Z'],
    ['an offset-bearing ISO', '2026-08-22T13:20:00.000+02:00']
  ])('normalizes %s to the same age', (_label, lastHeartbeatAt) => {
    expect(
      selectDispatchLivenessBreaches([candidate({ last_heartbeat_at: lastHeartbeatAt })], NOW)
    ).toMatchObject([{ silenceMs: 40 * MINUTE_MS, lastHeartbeatAt: '2026-08-22T11:20:00.000Z' }])
  })

  it('subtracts the parked interval before judging the window', () => {
    const parked = candidate({
      last_heartbeat_at: '2026-08-22T11:20:00.000Z',
      blocked_since: '2026-08-22T11:25:00.000Z'
    })

    expect(selectDispatchLivenessBreaches([parked], NOW)).toEqual([])
    expect(selectDispatchLivenessBreaches([{ ...parked, blocked_since: null }], NOW)).toHaveLength(
      1
    )
  })
})
