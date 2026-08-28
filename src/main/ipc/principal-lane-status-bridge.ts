// The host-only lane-status seam (S9 §2e/§2h, §10(d), rev 32's re-basing): the AccountsPane
// section's read of THIS desktop's own principal-lane residency and its remote-host
// discoverability rows. Sender-gated exactly as the consent and presence lanes are — a non-host
// frame gets the empty snapshot, never a roster.
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import {
  PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL,
  PRINCIPAL_LANE_STATUS_GET_CHANNEL,
  PRINCIPAL_LANE_STATUS_REFRESH_HOST_CHANNEL,
  type PrincipalLaneStatusRefreshHostRequest,
  type PrincipalLaneStatusRefreshHostResult,
  type PrincipalLaneStatusRemoteHostRow,
  type PrincipalLaneStatusSnapshot
} from '../../shared/principal-lane-status-ipc'
import {
  addLaneLoginDesktopStatusListener,
  listRemoteLaneHostRows,
  refreshLaneLoginHostStatus
} from '../claude-accounts/lane-login-desktop-service'
import { resolveLaneResidencyState } from '../claude-accounts/principal-lane-residency'
import { getPrincipalLaneConsentService } from '../runtime/principal-lane-consent-service'

const EMPTY_SNAPSHOT: PrincipalLaneStatusSnapshot = {
  lanes: [],
  remoteHosts: []
}

export type PrincipalLaneStatusBridgeOptions = {
  /** Injected in tests. Defaults to the attached consent surface's principal list. */
  listPrincipals?: () => readonly {
    principalId: string
    displayName: string
    delegatedGrantId?: string
  }[]
  /** Injected in tests. Defaults to the host residency reader. */
  resolveLaneState?: (principalId: string) => RuntimeTerminalLaneState
  /** Injected in tests. Defaults to one discoverability row per remote environment. */
  listRemoteHosts?: () => PrincipalLaneStatusRemoteHostRow[]
  /** Injected in tests. Defaults to re-querying one remote host's lane status on demand. */
  refreshHost?: (environmentId: string) => Promise<boolean>
}

// Why a broadcast set and not one window: provision/deprovision are process-wide events, and every
// registered host frame must re-read. A token guards teardown against macOS's window churn.
const broadcasters = new Set<() => void>()

/** Fired by the host events that change a principal lane's residency (provision, deprovision, wipe). */
export function notifyPrincipalLaneStatusChanged(): void {
  for (const broadcast of broadcasters) {
    broadcast()
  }
}

let activeRegistrationToken = 0

export function registerPrincipalLaneStatusBridge(
  mainWindow: BrowserWindow,
  options: PrincipalLaneStatusBridgeOptions = {}
): () => void {
  const token = ++activeRegistrationToken
  let disposed = false

  const listPrincipals =
    options.listPrincipals ?? (() => getPrincipalLaneConsentService()?.listPrincipals() ?? [])
  const resolveLaneState =
    options.resolveLaneState ?? ((id: string) => resolveLaneResidencyState(id))
  const listRemoteHosts =
    options.listRemoteHosts ?? (() => listRemoteLaneHostRows(app.getPath('userData')))
  const refreshHost =
    options.refreshHost ?? ((environmentId: string) => refreshLaneLoginHostStatus(environmentId))

  const isMainWindowSender = (event: IpcMainInvokeEvent): boolean =>
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed() &&
    event.sender === mainWindow.webContents

  const buildSnapshot = (): PrincipalLaneStatusSnapshot => ({
    lanes: listPrincipals().map((principal) => ({
      principalId: principal.principalId,
      displayName: principal.displayName,
      delegatedGrantId: principal.delegatedGrantId ?? null,
      laneState: resolveLaneState(principal.principalId)
    })),
    remoteHosts: listRemoteHosts()
  })

  const broadcast = (): void => {
    if (disposed || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      return
    }
    mainWindow.webContents.send(PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL, buildSnapshot())
  }
  broadcasters.add(broadcast)

  ipcMain.removeHandler(PRINCIPAL_LANE_STATUS_GET_CHANNEL)
  ipcMain.handle(PRINCIPAL_LANE_STATUS_GET_CHANNEL, (event): PrincipalLaneStatusSnapshot => {
    if (!isMainWindowSender(event)) {
      return EMPTY_SNAPSHOT
    }
    return buildSnapshot()
  })

  // Why the same sender gate: the Refresh button re-queries a remote host, which is a host-facing
  // act — a foreign sender must never trigger it.
  ipcMain.removeHandler(PRINCIPAL_LANE_STATUS_REFRESH_HOST_CHANNEL)
  ipcMain.handle(
    PRINCIPAL_LANE_STATUS_REFRESH_HOST_CHANNEL,
    async (
      event,
      request: PrincipalLaneStatusRefreshHostRequest
    ): Promise<PrincipalLaneStatusRefreshHostResult> => {
      if (!isMainWindowSender(event)) {
        return { refreshed: false }
      }
      const refreshed = await refreshHost(request.environmentId)
      broadcast()
      return { refreshed }
    }
  )

  // Discoverability follow-up: a remote client's status can change with no local IPC call at all —
  // a `status` frame off the lane-status stream, or a reachability-triggered reconnect — so the
  // desktop service's own listener, not just the write above, must be able to re-broadcast. Wired
  // to `notifyPrincipalLaneStatusChanged`, the same fan-out `broadcasters` already uses for
  // provision/deprovision, so every registered host frame re-reads regardless of which bridge
  // registration is the "active" one — not the per-window `broadcast` closure, which would
  // silently stop reaching every window but the newest.
  const removeStatusListener = addLaneLoginDesktopStatusListener(notifyPrincipalLaneStatusChanged)

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    broadcasters.delete(broadcast)
    removeStatusListener()
    if (activeRegistrationToken === token) {
      ipcMain.removeHandler(PRINCIPAL_LANE_STATUS_GET_CHANNEL)
      ipcMain.removeHandler(PRINCIPAL_LANE_STATUS_REFRESH_HOST_CHANNEL)
    }
  }

  mainWindow.on('closed', dispose)
  return dispose
}
