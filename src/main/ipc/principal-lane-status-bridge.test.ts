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
import type { ClaudeLaneDelegationLease } from '../../shared/claude-lane-lease'
import {
  PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL,
  PRINCIPAL_LANE_STATUS_DELEGATE_CHANNEL,
  PRINCIPAL_LANE_STATUS_GET_CHANNEL,
  PRINCIPAL_LANE_STATUS_RELEASE_CHANNEL,
  PRINCIPAL_LANE_STATUS_RENAME_CHANNEL,
  type PrincipalLaneStatusSnapshot
} from '../../shared/principal-lane-status-ipc'
import {
  notifyPrincipalLaneStatusChanged,
  registerPrincipalLaneStatusBridge
} from './principal-lane-status-bridge'

const LEASE: ClaudeLaneDelegationLease = {
  accountId: 'acct-1',
  accountUuid: null,
  hostId: 'host-1',
  principalId: 'prin-1',
  delegatedGrantId: 'dev-1',
  since: 1,
  expiresAt: null
}

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
    listDelegationLeases: () => [LEASE],
    listDelegableHosts: () => []
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

  it('answers the host frame with per-lane residency and this desktop leases', () => {
    const snapshot = invokeGet(stub.sender)
    expect(snapshot.lanes).toEqual([
      { principalId: 'prin-1', displayName: 'Ana', delegatedGrantId: 'dev-1', laneState: 'loaded' }
    ])
    expect(snapshot.delegationLeases).toEqual([LEASE])
  })

  it('gives a non-host sender the empty snapshot rather than the lanes', () => {
    const snapshot = invokeGet({})
    expect(snapshot).toEqual({ lanes: [], delegationLeases: [], delegableHosts: [] })
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
  let releaseLease: ReturnType<typeof vi.fn<(accountId: string) => boolean>>
  let renameLease: ReturnType<
    typeof vi.fn<(accountId: string, friendlyName: string | null) => boolean>
  >
  let delegateAccount: ReturnType<
    typeof vi.fn<(environmentId: string, accountId: string) => Promise<boolean>>
  >

  beforeEach(() => {
    handleMock.mockClear()
    removeHandlerMock.mockClear()
    stub = makeWindow()
    releaseLease = vi.fn<(accountId: string) => boolean>().mockReturnValue(true)
    renameLease = vi
      .fn<(accountId: string, friendlyName: string | null) => boolean>()
      .mockReturnValue(true)
    delegateAccount = vi
      .fn<(environmentId: string, accountId: string) => Promise<boolean>>()
      .mockResolvedValue(true)
    registerPrincipalLaneStatusBridge(stub.window, {
      ...options(),
      releaseLease,
      renameLease,
      delegateAccount
    })
  })

  it('releases a lease for the host frame and republishes', () => {
    const result = invokeChannel<{ released: boolean }>(
      PRINCIPAL_LANE_STATUS_RELEASE_CHANNEL,
      stub.sender,
      { accountId: 'acct-1' }
    )
    expect(result).toEqual({ released: true })
    expect(releaseLease).toHaveBeenCalledWith('acct-1')
    expect(
      stub.sends.filter((send) => send.channel === PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL)
    ).toHaveLength(1)
  })

  it('renames a lease for the host frame', () => {
    const result = invokeChannel<{ renamed: boolean }>(
      PRINCIPAL_LANE_STATUS_RENAME_CHANNEL,
      stub.sender,
      { accountId: 'acct-1', friendlyName: 'work' }
    )
    expect(result).toEqual({ renamed: true })
    expect(renameLease).toHaveBeenCalledWith('acct-1', 'work')
  })

  // Mutation proof: the sender check is the door. Deleting it turns these two refusals green->red.
  it('refuses a foreign sender BEFORE the lease store is touched (release)', () => {
    const result = invokeChannel<{ released: boolean }>(
      PRINCIPAL_LANE_STATUS_RELEASE_CHANNEL,
      {},
      { accountId: 'acct-1' }
    )
    expect(result).toEqual({ released: false })
    expect(releaseLease).not.toHaveBeenCalled()
  })

  it('refuses a foreign sender BEFORE the lease store is touched (rename)', () => {
    const result = invokeChannel<{ renamed: boolean }>(
      PRINCIPAL_LANE_STATUS_RENAME_CHANNEL,
      {},
      { accountId: 'acct-1', friendlyName: 'work' }
    )
    expect(result).toEqual({ renamed: false })
    expect(renameLease).not.toHaveBeenCalled()
  })

  it('delegates an account to a host for the host frame and republishes', async () => {
    const result = await invokeChannel<Promise<{ delegated: boolean }>>(
      PRINCIPAL_LANE_STATUS_DELEGATE_CHANNEL,
      stub.sender,
      { accountId: 'acct-1', environmentId: 'env-1' }
    )
    expect(result).toEqual({ delegated: true })
    expect(delegateAccount).toHaveBeenCalledWith('env-1', 'acct-1')
    expect(
      stub.sends.filter((send) => send.channel === PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL)
    ).toHaveLength(1)
  })

  // Mutation proof: the sender check is the door. Deleting it turns this refusal green->red.
  it('refuses a foreign sender BEFORE the delegate action runs', async () => {
    const result = await invokeChannel<Promise<{ delegated: boolean }>>(
      PRINCIPAL_LANE_STATUS_DELEGATE_CHANNEL,
      {},
      { accountId: 'acct-1', environmentId: 'env-1' }
    )
    expect(result).toEqual({ delegated: false })
    expect(delegateAccount).not.toHaveBeenCalled()
  })
})
