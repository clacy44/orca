import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { LaneStatusFrameIn } from './lane-delegation-push-client'

const {
  getRuntimeEnvironmentStatusMock,
  callRuntimeEnvironmentMock,
  subscribeRuntimeEnvironmentMock,
  isManuallyDisconnectedMock
} = vi.hoisted(() => ({
  getRuntimeEnvironmentStatusMock: vi.fn(),
  callRuntimeEnvironmentMock: vi.fn(),
  subscribeRuntimeEnvironmentMock: vi.fn(),
  isManuallyDisconnectedMock: vi.fn(() => false)
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-test-userdata' } }))

vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  getRuntimeEnvironmentStatus: getRuntimeEnvironmentStatusMock,
  callRuntimeEnvironment: callRuntimeEnvironmentMock,
  subscribeRuntimeEnvironment: subscribeRuntimeEnvironmentMock
}))

vi.mock('../ipc/runtime-environment-connectivity-handlers', () => ({
  isRuntimeEnvironmentManuallyDisconnected: isManuallyDisconnectedMock
}))

import {
  createLaneDelegationHostClient,
  LaneDelegationHostCallError
} from './lane-delegation-host-client'

function ok<T>(result: T): RuntimeRpcResponse<T> {
  return { id: 'x', ok: true, result, _meta: { runtimeId: 'runtime-a' } }
}

function fail(code: string, message: string): RuntimeRpcResponse<never> {
  return { id: 'x', ok: false, error: { code, message }, _meta: { runtimeId: 'runtime-a' } }
}

describe('lane delegation host client (release-audit B3 adapter)', () => {
  beforeEach(() => {
    getRuntimeEnvironmentStatusMock.mockReset()
    callRuntimeEnvironmentMock.mockReset()
    subscribeRuntimeEnvironmentMock.mockReset()
    isManuallyDisconnectedMock.mockReset()
    isManuallyDisconnectedMock.mockReturnValue(false)
  })

  it('reads capabilities off the environment status probe', async () => {
    getRuntimeEnvironmentStatusMock.mockResolvedValueOnce(
      ok({ capabilities: ['agent-identity-lanes.v1'] })
    )
    const client = createLaneDelegationHostClient('env-1')
    await expect(client.getCapabilities()).resolves.toEqual(['agent-identity-lanes.v1'])
  })

  // Chair decision (capability-probe stickiness): a failed status probe must read as "no answer
  // yet", not as `[]` — folding it into an empty array is indistinguishable from an ok response
  // that explicitly lacks the capability, which is exactly what made the push client's cache latch
  // "unsupported" on a transient failure.
  it('throws rather than answering no capabilities when the status probe fails', async () => {
    getRuntimeEnvironmentStatusMock.mockResolvedValueOnce(fail('runtime_unavailable', 'down'))
    const client = createLaneDelegationHostClient('env-1')
    await expect(client.getCapabilities()).rejects.toMatchObject({ code: 'runtime_unavailable' })
  })

  it('resolves call() to the RPC result on success', async () => {
    callRuntimeEnvironmentMock.mockResolvedValueOnce(ok({ refreshTokenSha256: 'a'.repeat(64) }))
    const client = createLaneDelegationHostClient('env-1')
    await expect(client.call('accounts.lane.push', { x: 1 })).resolves.toEqual({
      refreshTokenSha256: 'a'.repeat(64)
    })
    expect(callRuntimeEnvironmentMock).toHaveBeenCalledWith(
      '/tmp/orca-test-userdata',
      'env-1',
      'accounts.lane.push',
      { x: 1 }
    )
  })

  it('throws LaneDelegationHostCallError preserving the refusal code on a failed call()', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue(
      fail('accounts.lane.not_delegated', 'no designated pusher')
    )
    const client = createLaneDelegationHostClient('env-1')
    await expect(client.call('accounts.lane.push')).rejects.toMatchObject({
      code: 'accounts.lane.not_delegated',
      message: 'no designated pusher'
    })
    await expect(client.call('accounts.lane.push')).rejects.toBeInstanceOf(
      LaneDelegationHostCallError
    )
  })

  it('refuses every call once the host is manually disconnected', async () => {
    isManuallyDisconnectedMock.mockReturnValueOnce(true).mockReturnValueOnce(true)
    const client = createLaneDelegationHostClient('env-1')
    await expect(client.getCapabilities()).rejects.toMatchObject({
      code: 'runtime_manually_disconnected'
    })
    await expect(client.call('accounts.lane.push')).rejects.toMatchObject({
      code: 'runtime_manually_disconnected'
    })
    expect(getRuntimeEnvironmentStatusMock).not.toHaveBeenCalled()
    expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()
  })

  it('refuses subscribeLaneStatus once the host is manually disconnected', async () => {
    isManuallyDisconnectedMock.mockReturnValueOnce(true)
    const client = createLaneDelegationHostClient('env-1')
    await expect(client.subscribeLaneStatus(() => {})).rejects.toMatchObject({
      code: 'runtime_manually_disconnected'
    })
    expect(subscribeRuntimeEnvironmentMock).not.toHaveBeenCalled()
  })

  type Delivered = { onEvent: (payload: unknown) => void }

  function captureOnEvent(): { box: { current: Delivered['onEvent'] | null } } {
    const box: { current: Delivered['onEvent'] | null } = { current: null }
    subscribeRuntimeEnvironmentMock.mockImplementationOnce(async (..._args: unknown[]) => {
      box.current = (_args[5] as Delivered).onEvent
      return { close: vi.fn() }
    })
    return { box }
  }

  it('maps a response frame straight through and a close to an end frame', async () => {
    const { box } = captureOnEvent()
    const client = createLaneDelegationHostClient('env-1')
    const frames: LaneStatusFrameIn[] = []
    await client.subscribeLaneStatus((frame) => frames.push(frame))

    box.current?.({
      type: 'response',
      response: ok({ type: 'ready', status: { laneId: 'lane-a' } })
    })
    box.current?.({ type: 'close' })

    expect(frames).toEqual([{ type: 'ready', status: { laneId: 'lane-a' } }, { type: 'end' }])
  })

  it('maps a mid-stream error frame to an end frame too', async () => {
    const { box } = captureOnEvent()
    const client = createLaneDelegationHostClient('env-1')
    const frames: LaneStatusFrameIn[] = []
    await client.subscribeLaneStatus((frame) => frames.push(frame))

    box.current?.({ type: 'error', code: 'runtime_unavailable', message: 'socket dropped' })

    expect(frames).toEqual([{ type: 'end' }])
  })

  it('ignores a failed (ok:false) response frame rather than forwarding a malformed frame', async () => {
    const { box } = captureOnEvent()
    const client = createLaneDelegationHostClient('env-1')
    const frames: LaneStatusFrameIn[] = []
    await client.subscribeLaneStatus((frame) => frames.push(frame))

    box.current?.({ type: 'response', response: fail('runtime_unavailable', 'down') })

    expect(frames).toEqual([])
  })
})
