import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock },
  app: { getPath: vi.fn().mockReturnValue('/tmp/orca-test-user-data') }
}))

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import {
  PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL,
  PRINCIPAL_LANE_STATUS_GET_CHANNEL,
  PRINCIPAL_LANE_STATUS_REFRESH_HOST_CHANNEL,
  type PrincipalLaneStatusSnapshot
} from '../../shared/principal-lane-status-ipc'
import {
  notifyPrincipalLaneStatusChanged,
  registerPrincipalLaneStatusBridge
} from './principal-lane-status-bridge'

type WindowStub = {
  window: BrowserWindow
  sender: object
  sends: { channel: string; payload: unknown }[]
  close: () => void
}

function makeWindow(): WindowStub {
  const sends: { channel: string; payload: unknown }[] = []
  const closedListeners: (() => void)[] = []
  let destroyed = false
  const webContents = {
    isDestroyed: (): boolean => destroyed,
    send: (channel: string, payload: unknown): void => {
      sends.push({ channel, payload })
    }
  }
  const window = {
    isDestroyed: (): boolean => destroyed,
    webContents,
    on: (event: string, listener: () => void): void => {
      if (event === 'closed') {
        closedListeners.push(listener)
      }
    }
  } as unknown as BrowserWindow
  return {
    window,
    sender: webContents,
    sends,
    close: (): void => {
      destroyed = true
      closedListeners.forEach((listener) => listener())
    }
  }
}

function invokeGet(sender: object): PrincipalLaneStatusSnapshot {
  const entry = handleMock.mock.calls.findLast(
    (call) => call[0] === PRINCIPAL_LANE_STATUS_GET_CHANNEL
  ) as [string, (event: IpcMainInvokeEvent) => PrincipalLaneStatusSnapshot] | undefined
  if (!entry) {
    throw new Error('principalLaneStatus:get was never registered')
  }
  return entry[1]({ sender } as unknown as IpcMainInvokeEvent)
}

function options() {
  return {
    listPrincipals: () => [
      { principalId: 'prin-1', displayName: 'Ana', delegatedGrantId: 'dev-1' }
    ],
    resolveLaneState: (id: string) => (id === 'prin-1' ? ('loaded' as const) : ('absent' as const)),
    listRemoteHosts: () => []
  }
}

describe('principal lane status bridge', () => {
  let stub: WindowStub
  let dispose: () => void

  beforeEach(() => {
    handleMock.mockClear()
    removeHandlerMock.mockClear()
    stub = makeWindow()
    dispose = registerPrincipalLaneStatusBridge(stub.window, options())
  })

  it('answers the host frame with per-lane residency and remote discoverability rows', () => {
    const snapshot = invokeGet(stub.sender)
    expect(snapshot.lanes).toEqual([
      { principalId: 'prin-1', displayName: 'Ana', delegatedGrantId: 'dev-1', laneState: 'loaded' }
    ])
    expect(snapshot.remoteHosts).toEqual([])
  })

  it('gives a non-host sender the empty snapshot rather than the lanes', () => {
    const snapshot = invokeGet({})
    expect(snapshot).toEqual({ lanes: [], remoteHosts: [] })
  })

  it('broadcasts a fresh snapshot when a lane-status change fires', () => {
    notifyPrincipalLaneStatusChanged()
    const changed = stub.sends.findLast(
      (send) => send.channel === PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL
    )
    expect(changed?.payload).toMatchObject({
      lanes: [{ principalId: 'prin-1', laneState: 'loaded' }]
    })
  })

  it('stops broadcasting to a disposed window', () => {
    stub.close()
    notifyPrincipalLaneStatusChanged()
    expect(
      stub.sends.filter((send) => send.channel === PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL)
    ).toHaveLength(0)
    dispose()
  })
})

function invokeChannel<T>(channel: string, sender: object, request: unknown): T {
  const entry = handleMock.mock.calls.findLast((call) => call[0] === channel) as
    | [string, (event: IpcMainInvokeEvent, request: unknown) => T]
    | undefined
  if (!entry) {
    throw new Error(`${channel} was never registered`)
  }
  return entry[1]({ sender } as unknown as IpcMainInvokeEvent, request)
}

describe('principal lane status bridge writes', () => {
  let stub: WindowStub
  let refreshHost: ReturnType<typeof vi.fn<(environmentId: string) => Promise<boolean>>>

  beforeEach(() => {
    handleMock.mockClear()
    removeHandlerMock.mockClear()
    stub = makeWindow()
    refreshHost = vi.fn<(environmentId: string) => Promise<boolean>>().mockResolvedValue(true)
    registerPrincipalLaneStatusBridge(stub.window, { ...options(), refreshHost })
  })

  it('refreshes a remote host for the host frame and republishes', async () => {
    const result = await invokeChannel<Promise<{ refreshed: boolean }>>(
      PRINCIPAL_LANE_STATUS_REFRESH_HOST_CHANNEL,
      stub.sender,
      { environmentId: 'env-1' }
    )
    expect(result).toEqual({ refreshed: true })
    expect(refreshHost).toHaveBeenCalledWith('env-1')
    expect(
      stub.sends.filter((send) => send.channel === PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL)
    ).toHaveLength(1)
  })

  // Minor finding follow-up: a refused re-query must surface as `refreshed: false`, not silently
  // present as success — the renderer's Refresh button has nothing else to read the outcome from.
  it('reports a failed re-query instead of presenting it as a successful refresh', async () => {
    refreshHost.mockResolvedValue(false)
    const result = await invokeChannel<Promise<{ refreshed: boolean }>>(
      PRINCIPAL_LANE_STATUS_REFRESH_HOST_CHANNEL,
      stub.sender,
      { environmentId: 'env-1' }
    )
    expect(result).toEqual({ refreshed: false })
  })

  // Mutation proof: the sender check is the door. Deleting it turns this refusal green->red.
  it('refuses a foreign sender BEFORE the refresh runs', async () => {
    const result = await invokeChannel<Promise<{ refreshed: boolean }>>(
      PRINCIPAL_LANE_STATUS_REFRESH_HOST_CHANNEL,
      {},
      { environmentId: 'env-1' }
    )
    expect(result).toEqual({ refreshed: false })
    expect(refreshHost).not.toHaveBeenCalled()
  })
})
