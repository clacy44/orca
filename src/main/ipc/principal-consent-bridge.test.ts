import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  PRINCIPAL_CONSENT_BIND_CHANNEL,
  PRINCIPAL_CONSENT_CHANGED_CHANNEL,
  PRINCIPAL_CONSENT_PROVISION_CHANNEL,
  PRINCIPAL_CONSENT_SNAPSHOT_CHANNEL,
  type PrincipalConsentSnapshot
} from '../../shared/principal-consent-ipc'
import type { PrincipalLaneConsentService } from '../runtime/principal-lane-consent-service'
import { registerPrincipalConsentBridge } from './principal-consent-bridge'

type ServiceStub = Pick<
  PrincipalLaneConsentService,
  | 'listPrincipals'
  | 'listAudit'
  | 'boundDeviceIds'
  | 'createPrincipal'
  | 'bindGrant'
  | 'unbindGrant'
  | 'rebindGrant'
  | 'designatePusher'
  | 'provisionLane'
  | 'deprovisionLane'
>

function makeService(overrides: Partial<ServiceStub> = {}): ServiceStub {
  return {
    listPrincipals: vi.fn(() => [
      { principalId: 'prin-1', displayName: 'Ana', createdAt: 1, delegatedGrantId: 'dev-1' }
    ]),
    listAudit: vi.fn(() => [
      { at: 5, action: 'bind' as const, principalId: 'prin-1', deviceId: 'dev-1' }
    ]),
    boundDeviceIds: vi.fn((principalId: string) => (principalId === 'prin-1' ? ['dev-1'] : [])),
    createPrincipal: vi.fn(() => ({ principalId: 'prin-new', displayName: 'Ben', createdAt: 2 })),
    bindGrant: vi.fn(),
    unbindGrant: vi.fn(() => true),
    rebindGrant: vi.fn(),
    designatePusher: vi.fn(),
    provisionLane: vi.fn(() => ({ provenanceLabel: 'orca-lane:prin-1' })),
    deprovisionLane: vi.fn(async () => true),
    ...overrides
  } as ServiceStub
}

type WindowStub = {
  window: BrowserWindow
  sender: object
  sends: { channel: string; payload: unknown }[]
}

function makeWindow(): WindowStub {
  const sends: { channel: string; payload: unknown }[] = []
  const webContents = {
    isDestroyed: (): boolean => false,
    send: (channel: string, payload: unknown): void => {
      sends.push({ channel, payload })
    }
  }
  const window = {
    isDestroyed: (): boolean => false,
    webContents,
    on: (): void => {}
  } as unknown as BrowserWindow
  return { window, sender: webContents, sends }
}

function handlerFor(channel: string): (event: IpcMainInvokeEvent, request?: unknown) => unknown {
  const entry = handleMock.mock.calls.findLast((call) => call[0] === channel) as
    | [string, (event: IpcMainInvokeEvent, request?: unknown) => unknown]
    | undefined
  if (!entry) {
    throw new Error(`${channel} was never registered`)
  }
  return entry[1]
}

function invoke(channel: string, sender: object, request?: unknown): unknown {
  return handlerFor(channel)({ sender } as unknown as IpcMainInvokeEvent, request)
}

describe('principal consent bridge', () => {
  let service: ServiceStub
  let stub: WindowStub

  beforeEach(() => {
    handleMock.mockClear()
    removeHandlerMock.mockClear()
    service = makeService()
    stub = makeWindow()
    registerPrincipalConsentBridge(stub.window, {
      resolveService: () => service as unknown as PrincipalLaneConsentService
    })
  })

  it('joins principals, bindings and audit for the host frame', () => {
    const snapshot = invoke(
      PRINCIPAL_CONSENT_SNAPSHOT_CHANNEL,
      stub.sender
    ) as PrincipalConsentSnapshot
    expect(snapshot.principals).toEqual([
      { principalId: 'prin-1', displayName: 'Ana', delegatedGrantId: 'dev-1' }
    ])
    expect(snapshot.bindings).toEqual([{ deviceId: 'dev-1', principalId: 'prin-1' }])
    expect(snapshot.audit).toEqual([
      { at: 5, action: 'bind', principalId: 'prin-1', deviceId: 'dev-1' }
    ])
  })

  it('returns an empty snapshot to a non-host sender rather than the roster', () => {
    const snapshot = invoke(PRINCIPAL_CONSENT_SNAPSHOT_CHANNEL, {}) as PrincipalConsentSnapshot
    expect(snapshot).toEqual({ principals: [], bindings: [], audit: [] })
    expect(service.listPrincipals).not.toHaveBeenCalled()
  })

  it('performs a bind from the host frame and republishes the snapshot', () => {
    const result = invoke(PRINCIPAL_CONSENT_BIND_CHANNEL, stub.sender, {
      deviceId: 'dev-1',
      principalId: 'prin-1'
    })
    expect(result).toEqual({ bound: true })
    expect(service.bindGrant).toHaveBeenCalledWith({ source: 'local-socket' }, 'dev-1', 'prin-1')
    const changed = stub.sends.findLast(
      (send) => send.channel === PRINCIPAL_CONSENT_CHANGED_CHANNEL
    )
    expect(changed?.payload).toMatchObject({
      bindings: [{ deviceId: 'dev-1', principalId: 'prin-1' }]
    })
  })

  // MUTATION PROOF. Guard: the `event.sender === mainWindow.webContents` sender check in
  // `requireHostSender`. Delete it (admit any sender) and this bind from a FOREIGN sender would
  // reach `service.bindGrant` and return `{ bound: true }` instead of throwing — so this goes red.
  it('refuses a bind from a foreign sender before any consent is constructed', () => {
    expect(() =>
      invoke(PRINCIPAL_CONSENT_BIND_CHANNEL, {}, { deviceId: 'dev-1', principalId: 'prin-1' })
    ).toThrow(ClaudeLaneRefusal)
    expect(() =>
      invoke(PRINCIPAL_CONSENT_BIND_CHANNEL, {}, { deviceId: 'dev-1', principalId: 'prin-1' })
    ).toThrow(/decisions made at the host machine/)
    expect(service.bindGrant).not.toHaveBeenCalled()
  })

  it('refuses provision from a foreign sender', () => {
    expect(() =>
      invoke(PRINCIPAL_CONSENT_PROVISION_CHANNEL, {}, { principalId: 'prin-1' })
    ).toThrow(ClaudeLaneRefusal)
    expect(service.provisionLane).not.toHaveBeenCalled()
  })

  it('refuses a host-frame write when no lane service is attached', () => {
    handleMock.mockClear()
    registerPrincipalConsentBridge(stub.window, { resolveService: () => null })
    expect(() =>
      invoke(PRINCIPAL_CONSENT_BIND_CHANNEL, stub.sender, {
        deviceId: 'dev-1',
        principalId: 'prin-1'
      })
    ).toThrow(ClaudeLaneRefusal)
  })

  it('provisions from the host frame and reports the provenance label', () => {
    const result = invoke(PRINCIPAL_CONSENT_PROVISION_CHANNEL, stub.sender, {
      principalId: 'prin-1'
    })
    expect(result).toEqual({ provisioned: true, provenanceLabel: 'orca-lane:prin-1' })
    expect(service.provisionLane).toHaveBeenCalledWith({ source: 'local-socket' }, 'prin-1')
  })
})
