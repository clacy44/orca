import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import {
  LANE_LOGIN_GET_CHANNEL,
  LANE_LOGIN_SELECT_ACCOUNT_CHANNEL,
  LANE_LOGIN_START_CHANNEL
} from '../../shared/lane-login-ipc'
import { registerLaneLoginBridge } from './lane-login-bridge'
import type { LaneLoginDesktopService } from '../claude-accounts/lane-login-desktop-service'

type WindowStub = {
  window: BrowserWindow
  sender: object
  foreignSender: object
  close: () => void
}

function makeWindow(): WindowStub {
  let destroyed = false
  const webContents = { isDestroyed: (): boolean => destroyed, send: vi.fn() }
  const window = {
    isDestroyed: (): boolean => destroyed,
    webContents,
    on: vi.fn()
  } as unknown as BrowserWindow
  return { window, sender: webContents, foreignSender: {}, close: () => (destroyed = true) }
}

function handlerFor(channel: string) {
  const entry = handleMock.mock.calls.findLast((call) => call[0] === channel) as
    | [string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown]
    | undefined
  if (!entry) {
    throw new Error(`${channel} was never registered`)
  }
  return entry[1]
}

function fakeService(): LaneLoginDesktopService {
  return {
    addStatusListener: vi.fn(() => () => {}),
    connect: vi.fn(async () => 'supported'),
    getSnapshot: vi.fn(() => ({
      environmentId: 'env-1',
      capability: 'supported',
      accounts: [],
      activeLoginSessionId: null,
      activeLoginExpiresAt: null,
      lastLoginError: null
    })),
    loginStart: vi.fn(async () => ({
      loginSessionId: 's1',
      authorizeUrl: 'https://platform.claude.com/x',
      expiresAt: 1
    })),
    loginSubmitCode: vi.fn(),
    loginCancel: vi.fn(),
    selectAccount: vi.fn(async () => ({ active: 'acct-1' })),
    removeAccount: vi.fn(),
    logout: vi.fn(),
    disconnect: vi.fn()
  } as unknown as LaneLoginDesktopService
}

describe('lane login bridge', () => {
  let stub: WindowStub
  let service: LaneLoginDesktopService

  beforeEach(() => {
    handleMock.mockClear()
    removeHandlerMock.mockClear()
    stub = makeWindow()
    service = fakeService()
    registerLaneLoginBridge(stub.window, service)
  })

  it('a foreign sender is refused on loginStart rather than reaching the service', async () => {
    const handler = handlerFor(LANE_LOGIN_START_CHANNEL)
    const result = await handler({ sender: stub.foreignSender } as unknown as IpcMainInvokeEvent, {
      environmentId: 'env-1',
      expectedEmail: 'a@b.com'
    })
    expect(result).toMatchObject({ refused: { code: 'not_host_sender' } })
    expect(service.loginStart).not.toHaveBeenCalled()
  })

  it('the host window can start a login and gets the exact loginStart shape back', async () => {
    const handler = handlerFor(LANE_LOGIN_START_CHANNEL)
    const result = await handler({ sender: stub.sender } as unknown as IpcMainInvokeEvent, {
      environmentId: 'env-1',
      expectedEmail: 'a@b.com'
    })
    expect(service.loginStart).toHaveBeenCalledWith('env-1', 'a@b.com')
    expect(result).toMatchObject({ loginSessionId: 's1' })
  })

  it('get connects and returns the environment snapshot for the host sender', async () => {
    const handler = handlerFor(LANE_LOGIN_GET_CHANNEL)
    const result = await handler({ sender: stub.sender } as unknown as IpcMainInvokeEvent, 'env-1')
    expect(service.connect).toHaveBeenCalledWith('env-1')
    expect(result).toMatchObject({ environmentId: 'env-1' })
  })

  it('get returns null for a foreign sender rather than probing the host', async () => {
    const handler = handlerFor(LANE_LOGIN_GET_CHANNEL)
    const result = await handler(
      { sender: stub.foreignSender } as unknown as IpcMainInvokeEvent,
      'env-1'
    )
    expect(result).toBeNull()
    expect(service.connect).not.toHaveBeenCalled()
  })

  it('selectAccount from the host resolves synchronously to {active}', async () => {
    const handler = handlerFor(LANE_LOGIN_SELECT_ACCOUNT_CHANNEL)
    const result = await handler({ sender: stub.sender } as unknown as IpcMainInvokeEvent, {
      environmentId: 'env-1',
      laneAccountId: 'acct-1'
    })
    expect(result).toEqual({ active: 'acct-1' })
  })

  // Mutation proof: dropping the sender check on any write handler turns the foreign-sender test
  // above red — a foreign frame could otherwise start a login for the host's own principal.
  it('MUTATION PROOF: the foreign-sender guard is what the first test depends on', async () => {
    const handler = handlerFor(LANE_LOGIN_START_CHANNEL)
    stub.close()
    const result = await handler({ sender: stub.sender } as unknown as IpcMainInvokeEvent, {
      environmentId: 'env-1',
      expectedEmail: 'a@b.com'
    })
    expect(result).toMatchObject({ refused: { code: 'not_host_sender' } })
  })
})
