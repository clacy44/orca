// S9-L2 (design rev 38 §2l/§3, §10(d) sender-gate precedent): renderer-facing IPC over
// `LaneLoginDesktopService`. Sender-gated exactly as `principal-lane-status-bridge.ts` and
// `principal-consent-bridge.ts` are — a non-main-window sender gets a refused/empty result, never
// a write.
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  LANE_LOGIN_CANCEL_CHANNEL,
  LANE_LOGIN_CHANGED_CHANNEL,
  LANE_LOGIN_GET_CHANNEL,
  LANE_LOGIN_LOGOUT_CHANNEL,
  LANE_LOGIN_REMOVE_ACCOUNT_CHANNEL,
  LANE_LOGIN_SELECT_ACCOUNT_CHANNEL,
  LANE_LOGIN_START_CHANNEL,
  LANE_LOGIN_SUBMIT_CODE_CHANNEL,
  type LaneLoginCancelRequest,
  type LaneLoginCancelResponse,
  type LaneLoginEnvironmentSnapshotDto,
  type LaneLoginStartRequest,
  type LaneLoginStartResponse,
  type LaneLoginSubmitCodeRequest,
  type LaneLoginSubmitCodeResponse,
  type LaneLogoutRequest,
  type LaneLogoutResponse,
  type LaneRemoveAccountRequest,
  type LaneRemoveAccountResponse,
  type LaneSelectAccountRequest,
  type LaneSelectAccountResponse
} from '../../shared/lane-login-ipc'
import type { LaneLoginDesktopService } from '../claude-accounts/lane-login-desktop-service'

const NOT_HOST_REFUSAL = {
  refused: { code: 'not_host_sender', message: 'Refused: not the host window.' }
}

let activeRegistrationToken = 0

export function registerLaneLoginBridge(
  mainWindow: BrowserWindow,
  service: LaneLoginDesktopService
): () => void {
  const token = ++activeRegistrationToken
  let disposed = false

  const isMainWindowSender = (event: IpcMainInvokeEvent): boolean =>
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed() &&
    event.sender === mainWindow.webContents

  const broadcast = (environmentId: string): void => {
    if (disposed || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      return
    }
    const snapshot: LaneLoginEnvironmentSnapshotDto = service.getSnapshot(environmentId)
    mainWindow.webContents.send(LANE_LOGIN_CHANGED_CHANNEL, snapshot)
  }

  // One listener per registration is enough: every mutation below re-broadcasts explicitly, and
  // the service's own status frames (login-started/-completed/-failed, account list changes) are
  // per-environment, so this listener re-sends the LAST environment mutated. Renderer callers key
  // their own state by `environmentId` in the payload, so a stale unrelated row is never applied.
  let lastTouchedEnvironmentId: string | null = null
  const removeStatusListener = service.addStatusListener(() => {
    if (lastTouchedEnvironmentId) {
      broadcast(lastTouchedEnvironmentId)
    }
  })

  const track = (environmentId: string): void => {
    lastTouchedEnvironmentId = environmentId
  }

  ipcMain.removeHandler(LANE_LOGIN_GET_CHANNEL)
  ipcMain.handle(
    LANE_LOGIN_GET_CHANNEL,
    (event, environmentId: string): LaneLoginEnvironmentSnapshotDto | null => {
      if (!isMainWindowSender(event)) {
        return null
      }
      track(environmentId)
      void service.connect(environmentId)
      return service.getSnapshot(environmentId)
    }
  )

  ipcMain.removeHandler(LANE_LOGIN_START_CHANNEL)
  ipcMain.handle(
    LANE_LOGIN_START_CHANNEL,
    async (event, request: LaneLoginStartRequest): Promise<LaneLoginStartResponse> => {
      if (!isMainWindowSender(event)) {
        return NOT_HOST_REFUSAL
      }
      track(request.environmentId)
      return service.loginStart(request.environmentId, request.expectedEmail)
    }
  )

  ipcMain.removeHandler(LANE_LOGIN_SUBMIT_CODE_CHANNEL)
  ipcMain.handle(
    LANE_LOGIN_SUBMIT_CODE_CHANNEL,
    async (event, request: LaneLoginSubmitCodeRequest): Promise<LaneLoginSubmitCodeResponse> => {
      if (!isMainWindowSender(event)) {
        return NOT_HOST_REFUSAL
      }
      track(request.environmentId)
      return service.loginSubmitCode(request.environmentId, request.loginSessionId, request.code)
    }
  )

  ipcMain.removeHandler(LANE_LOGIN_CANCEL_CHANNEL)
  ipcMain.handle(
    LANE_LOGIN_CANCEL_CHANNEL,
    async (event, request: LaneLoginCancelRequest): Promise<LaneLoginCancelResponse> => {
      if (!isMainWindowSender(event)) {
        return { cancelled: false }
      }
      track(request.environmentId)
      return service.loginCancel(request.environmentId, request.loginSessionId)
    }
  )

  ipcMain.removeHandler(LANE_LOGIN_SELECT_ACCOUNT_CHANNEL)
  ipcMain.handle(
    LANE_LOGIN_SELECT_ACCOUNT_CHANNEL,
    async (event, request: LaneSelectAccountRequest): Promise<LaneSelectAccountResponse> => {
      if (!isMainWindowSender(event)) {
        return NOT_HOST_REFUSAL
      }
      track(request.environmentId)
      return service.selectAccount(request.environmentId, request.laneAccountId)
    }
  )

  ipcMain.removeHandler(LANE_LOGIN_REMOVE_ACCOUNT_CHANNEL)
  ipcMain.handle(
    LANE_LOGIN_REMOVE_ACCOUNT_CHANNEL,
    async (event, request: LaneRemoveAccountRequest): Promise<LaneRemoveAccountResponse> => {
      if (!isMainWindowSender(event)) {
        return NOT_HOST_REFUSAL
      }
      track(request.environmentId)
      return service.removeAccount(request.environmentId, request.laneAccountId)
    }
  )

  ipcMain.removeHandler(LANE_LOGIN_LOGOUT_CHANNEL)
  ipcMain.handle(
    LANE_LOGIN_LOGOUT_CHANNEL,
    async (event, request: LaneLogoutRequest): Promise<LaneLogoutResponse> => {
      if (!isMainWindowSender(event)) {
        return NOT_HOST_REFUSAL
      }
      track(request.environmentId)
      return service.logout(request.environmentId)
    }
  )

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    removeStatusListener()
    if (activeRegistrationToken === token) {
      ipcMain.removeHandler(LANE_LOGIN_GET_CHANNEL)
      ipcMain.removeHandler(LANE_LOGIN_START_CHANNEL)
      ipcMain.removeHandler(LANE_LOGIN_SUBMIT_CODE_CHANNEL)
      ipcMain.removeHandler(LANE_LOGIN_CANCEL_CHANNEL)
      ipcMain.removeHandler(LANE_LOGIN_SELECT_ACCOUNT_CHANNEL)
      ipcMain.removeHandler(LANE_LOGIN_REMOVE_ACCOUNT_CHANNEL)
      ipcMain.removeHandler(LANE_LOGIN_LOGOUT_CHANNEL)
    }
  }

  mainWindow.on('closed', dispose)
  return dispose
}
