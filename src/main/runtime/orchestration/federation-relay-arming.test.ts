import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { syncFederatedDispatchMock } = vi.hoisted(() => ({ syncFederatedDispatchMock: vi.fn() }))

// Why: drive the real relay scheduler — mocking the runtime's own sync method would
// also mock the health recording the backoff reads.
vi.mock('./federation-sync', () => ({
  syncFederatedDispatch: syncFederatedDispatchMock,
  parseRelayedMessage: () => {
    throw new Error('unused')
  }
}))

import { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationEnvironmentTransport } from './environment-transport'
import {
  isFederationRelayActiveWorkerState,
  selectFederationRelayResumeDispatchIds
} from './federation-relay-arming'
import {
  federationRelayIntervalMs,
  FEDERATION_RELAY_MAX_INTERVAL_MS,
  recordFederationSyncFailure,
  recordFederationSyncSuccess
} from './federation-sync-health'
import { OrchestrationError } from './orchestration-error'

const IDLE_TRANSPORT = {
  resolve: () => ({ environmentId: 'environment_peer', name: 'peer', peerFingerprint: 'peer_fp' }),
  call: async () => ({ id: 'unused', ok: true, result: {}, _meta: { runtimeId: 'peer' } })
} as unknown as OrchestrationEnvironmentTransport

type WorkerState = string

function createRelayHarness(states: Record<string, WorkerState>) {
  const runtime = new OrcaRuntimeService(null, undefined, {
    orchestrationEnvironmentTransport: IDLE_TRANSPORT
  })
  runtime.setOrchestrationDb({
    listActiveFederatedDispatches: () =>
      Object.keys(states).map((dispatchId) => ({ dispatch_id: dispatchId })),
    getWorkerDispatch: (dispatchId: string) =>
      states[dispatchId] ? { state: states[dispatchId] } : undefined
  } as never)
  return { runtime, sync: syncFederatedDispatchMock, states }
}

describe('federation relay arming', () => {
  it('treats only pre-settlement worker states as relay-active', () => {
    expect(['starting', 'ready', 'stopping'].map(isFederationRelayActiveWorkerState)).toEqual([
      true,
      true,
      true
    ])
    expect(
      ['succeeded', 'failed', 'stopped', 'start_unknown', 'stop_unknown', undefined].map(
        isFederationRelayActiveWorkerState
      )
    ).toEqual([false, false, false, false, false, false])
  })

  it('selects the still-active dispatches to resume and de-duplicates them', () => {
    expect(
      selectFederationRelayResumeDispatchIds([
        { dispatchId: 'dispatch_ready', workerState: 'ready' },
        { dispatchId: 'dispatch_settled', workerState: 'succeeded' },
        { dispatchId: 'dispatch_stopping', workerState: 'stopping' },
        { dispatchId: 'dispatch_ready', workerState: 'ready' },
        { dispatchId: 'dispatch_gone', workerState: undefined }
      ])
    ).toEqual(['dispatch_ready', 'dispatch_stopping'])
  })
})

describe('federation sync health', () => {
  it('counts consecutive failures and keeps the last successful sync time', () => {
    const first = recordFederationSyncFailure(
      undefined,
      new OrchestrationError('peer_changed', 'Rotated.')
    )
    expect(first).toEqual({
      lastSyncAt: null,
      lastError: 'peer_changed: Rotated.',
      consecutiveFailures: 1
    })

    const healthy = recordFederationSyncSuccess('2026-08-20T00:00:00.000Z')
    expect(healthy).toEqual({
      lastSyncAt: '2026-08-20T00:00:00.000Z',
      lastError: null,
      consecutiveFailures: 0
    })

    const second = recordFederationSyncFailure(healthy, new Error('socket hang up'))
    expect(second).toEqual({
      lastSyncAt: '2026-08-20T00:00:00.000Z',
      lastError: 'socket hang up',
      consecutiveFailures: 1
    })
    expect(
      recordFederationSyncFailure(second, new Error('socket hang up')).consecutiveFailures
    ).toBe(2)
  })

  it('doubles the retry interval per failure up to the cap and resets on success', () => {
    expect([0, 1, 2, 3].map(federationRelayIntervalMs)).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(federationRelayIntervalMs(20)).toBe(FEDERATION_RELAY_MAX_INTERVAL_MS)
  })
})

describe('federation relay scheduling', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    syncFederatedDispatchMock.mockReset()
    syncFederatedDispatchMock.mockResolvedValue(undefined)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    warn.mockRestore()
  })

  it('polls a ready dispatch on the base interval', async () => {
    const { runtime, sync } = createRelayHarness({ dispatch_ready: 'ready' })

    runtime.ensureOrchestrationFederationRelay()
    expect(sync).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(sync).toHaveBeenCalledTimes(2)

    runtime.stopOrchestrationFederationRelay()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('arms one relay per dispatch no matter how often ensure is called', async () => {
    const { runtime, sync } = createRelayHarness({ dispatch_ready: 'ready' })

    runtime.ensureOrchestrationFederationRelay()
    runtime.ensureOrchestrationFederationRelay()
    runtime.ensureOrchestrationFederationRelay()
    expect(sync).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(sync).toHaveBeenCalledTimes(2)
    runtime.stopOrchestrationFederationRelay()
  })

  it('backs off exponentially while the peer keeps failing and recovers on success', async () => {
    const { runtime, sync } = createRelayHarness({ dispatch_ready: 'ready' })
    sync.mockRejectedValue(new OrchestrationError('runtime_unreachable', 'Peer is down.'))

    runtime.ensureOrchestrationFederationRelay()
    await vi.advanceTimersByTimeAsync(0)
    expect(sync).toHaveBeenCalledTimes(1)

    // Why: the bare 1s interval would have retried here; the first failure owes 2s.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sync).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(3_999)
    expect(sync).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(sync).toHaveBeenCalledTimes(3)

    sync.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(sync).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sync).toHaveBeenCalledTimes(5)

    runtime.stopOrchestrationFederationRelay()
  })

  it('stops polling once the dispatch settles', async () => {
    const harness = createRelayHarness({ dispatch_ready: 'ready' })

    harness.runtime.ensureOrchestrationFederationRelay()
    expect(harness.sync).toHaveBeenCalledTimes(1)

    harness.states.dispatch_ready = 'succeeded'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.sync).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.sync).toHaveBeenCalledTimes(1)
  })

  it('re-arms unsettled federated dispatches after a restart', async () => {
    const { runtime, sync } = createRelayHarness({
      dispatch_starting: 'starting',
      dispatch_ready: 'ready',
      dispatch_stopping: 'stopping',
      dispatch_done: 'succeeded'
    })

    expect(runtime.resumeOrchestrationFederationRelayAfterRestart()).toEqual([
      'dispatch_starting',
      'dispatch_ready',
      'dispatch_stopping'
    ])
    expect(sync.mock.calls.map(([, dispatchId]) => dispatchId)).toEqual([
      'dispatch_starting',
      'dispatch_ready',
      'dispatch_stopping'
    ])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(sync).toHaveBeenCalledTimes(6)
    runtime.stopOrchestrationFederationRelay()
  })

  it('resumes nothing when the runtime cannot federate', () => {
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb({
      listActiveFederatedDispatches: () => [{ dispatch_id: 'dispatch_ready' }],
      getWorkerDispatch: () => ({ state: 'ready' })
    } as never)

    expect(runtime.resumeOrchestrationFederationRelayAfterRestart()).toEqual([])
  })

  it('survives a boot scan that cannot read the orchestration database', () => {
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: IDLE_TRANSPORT
    })
    const scanWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtime.setOrchestrationDb({
      listActiveFederatedDispatches: () => {
        throw new Error('database is locked')
      }
    } as never)

    expect(runtime.resumeOrchestrationFederationRelayAfterRestart()).toEqual([])
    expect(scanWarn).toHaveBeenCalled()
    scanWarn.mockRestore()
  })
})
