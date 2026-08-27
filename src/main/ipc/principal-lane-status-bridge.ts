// The host-only lane-status seam (S9 §2e/§2h, §10(d)): the AccountsPane section's read of THIS
// desktop's own principal-lane residency and its delegation leases. Sender-gated exactly as the
// consent and presence lanes are — a non-host frame gets the empty snapshot, never a roster. The
// desktop's own lanes have no paired-client wire; a REMOTE host's lane status is a separate,
// pre-existing `accounts.lane.status` RPC path and is not this lane's concern.
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { ClaudeLaneDelegationLease } from '../../shared/claude-lane-lease'
import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import {
  PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL,
  PRINCIPAL_LANE_STATUS_DELEGATE_CHANNEL,
  PRINCIPAL_LANE_STATUS_GET_CHANNEL,
  PRINCIPAL_LANE_STATUS_REFRESH_HOST_CHANNEL,
  PRINCIPAL_LANE_STATUS_RELEASE_CHANNEL,
  PRINCIPAL_LANE_STATUS_RENAME_CHANNEL,
  type PrincipalLaneStatusDelegableHost,
  type PrincipalLaneStatusDelegateRequest,
  type PrincipalLaneStatusDelegateResult,
  type PrincipalLaneStatusRefreshHostRequest,
  type PrincipalLaneStatusRefreshHostResult,
  type PrincipalLaneStatusReleaseRequest,
  type PrincipalLaneStatusReleaseResult,
  type PrincipalLaneStatusRemoteHostRow,
  type PrincipalLaneStatusRenameRequest,
  type PrincipalLaneStatusRenameResult,
  type PrincipalLaneStatusSnapshot
} from '../../shared/principal-lane-status-ipc'
import {
  delegateAccountToLaneHost,
  listDelegableLaneHosts,
  listRemoteLaneHostRows,
  refreshLaneDelegationHostStatus,
  setLaneDelegationDesktopStatusListener
} from '../claude-accounts/lane-delegation-desktop-service'
import { getLaneDelegationLeaseStore } from '../claude-accounts/lane-delegation-lease'
import { resolveLaneResidencyState } from '../claude-accounts/principal-lane-residency'
import { getPrincipalLaneConsentService } from '../runtime/principal-lane-consent-service'

const EMPTY_SNAPSHOT: PrincipalLaneStatusSnapshot = {
  lanes: [],
  delegationLeases: [],
  delegableHosts: [],
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
  /** Injected in tests. Defaults to this desktop's persisted lease list. */
  listDelegationLeases?: () => ClaudeLaneDelegationLease[]
  /** Injected in tests. Defaults to dropping this desktop's lease for the account (§2e recovery). */
  releaseLease?: (accountId: string) => boolean
  /** Injected in tests. Defaults to persisting the Q3 friendly name on the lease. */
  renameLease?: (accountId: string, friendlyName: string | null) => boolean
  /** Injected in tests. Defaults to this desktop's connected, designated-pusher hosts. */
  listDelegableHosts?: () => PrincipalLaneStatusDelegableHost[]
  /** Injected in tests. Defaults to one discoverability row per remote environment (B3 follow-up). */
  listRemoteHosts?: () => PrincipalLaneStatusRemoteHostRow[]
  /** Injected in tests. Defaults to pushing the named account onto the named host lane. */
  delegateAccount?: (environmentId: string, accountId: string) => Promise<boolean>
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
  const listDelegationLeases =
    options.listDelegationLeases ?? (() => getLaneDelegationLeaseStore()?.list() ?? [])
  const releaseLease =
    options.releaseLease ??
    ((accountId: string) => getLaneDelegationLeaseStore()?.release(accountId) ?? false)
  const renameLease =
    options.renameLease ??
    ((accountId: string, friendlyName: string | null) =>
      getLaneDelegationLeaseStore()?.rename(accountId, friendlyName) ?? false)
  const listDelegableHosts =
    options.listDelegableHosts ?? (() => listDelegableLaneHosts(app.getPath('userData')))
  const listRemoteHosts =
    options.listRemoteHosts ?? (() => listRemoteLaneHostRows(app.getPath('userData')))
  const delegateAccount =
    options.delegateAccount ??
    ((environmentId: string, accountId: string) =>
      delegateAccountToLaneHost(environmentId, accountId))
  const refreshHost =
    options.refreshHost ??
    ((environmentId: string) => refreshLaneDelegationHostStatus(environmentId))

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
    delegationLeases: listDelegationLeases(),
    delegableHosts: listDelegableHosts(),
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

  // Why the sender check gates these two writes exactly as `get` gates the read: releasing a lease
  // un-suppresses this desktop's own rotation and renaming persists a human label — both are host
  // acts, refused to any foreign sender BEFORE the lease store is touched (§2e, terminal-presence
  // precedent). A write republishes so every host frame re-reads the lease view.
  ipcMain.removeHandler(PRINCIPAL_LANE_STATUS_RELEASE_CHANNEL)
  ipcMain.handle(
    PRINCIPAL_LANE_STATUS_RELEASE_CHANNEL,
    (event, request: PrincipalLaneStatusReleaseRequest): PrincipalLaneStatusReleaseResult => {
      if (!isMainWindowSender(event)) {
        return { released: false }
      }
      const released = releaseLease(request.accountId)
      if (released) {
        broadcast()
      }
      return { released }
    }
  )

  ipcMain.removeHandler(PRINCIPAL_LANE_STATUS_RENAME_CHANNEL)
  ipcMain.handle(
    PRINCIPAL_LANE_STATUS_RENAME_CHANNEL,
    (event, request: PrincipalLaneStatusRenameRequest): PrincipalLaneStatusRenameResult => {
      if (!isMainWindowSender(event)) {
        return { renamed: false }
      }
      const renamed = renameLease(request.accountId, request.friendlyName)
      if (renamed) {
        broadcast()
      }
      return { renamed }
    }
  )

  // Why the same sender gate: delegating pushes a credential onto a shared host, exactly as
  // release/rename mutate the lease view — a foreign sender must never trigger either.
  ipcMain.removeHandler(PRINCIPAL_LANE_STATUS_DELEGATE_CHANNEL)
  ipcMain.handle(
    PRINCIPAL_LANE_STATUS_DELEGATE_CHANNEL,
    async (
      event,
      request: PrincipalLaneStatusDelegateRequest
    ): Promise<PrincipalLaneStatusDelegateResult> => {
      if (!isMainWindowSender(event)) {
        return { delegated: false }
      }
      const delegated = await delegateAccount(request.environmentId, request.accountId)
      if (delegated) {
        broadcast()
      }
      return { delegated }
    }
  )

  // Why the same sender gate: the Refresh button re-queries a remote host, which is a host-facing
  // act exactly like delegate/release/rename — a foreign sender must never trigger it either.
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
  // a `status` frame off the lane-status stream, or a reachability-triggered `refreshStatus()` —
  // so the desktop service's own listener, not just the two writes above, must be able to
  // re-broadcast. Wired to `notifyPrincipalLaneStatusChanged`, the same fan-out `broadcasters`
  // already uses for provision/deprovision, so every registered host frame re-reads regardless of
  // which bridge registration is the "active" one — not the per-window `broadcast` closure, which
  // would silently stop reaching every window but the newest.
  setLaneDelegationDesktopStatusListener(notifyPrincipalLaneStatusChanged)

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    broadcasters.delete(broadcast)
    if (activeRegistrationToken === token) {
      ipcMain.removeHandler(PRINCIPAL_LANE_STATUS_GET_CHANNEL)
      ipcMain.removeHandler(PRINCIPAL_LANE_STATUS_RELEASE_CHANNEL)
      ipcMain.removeHandler(PRINCIPAL_LANE_STATUS_RENAME_CHANNEL)
      ipcMain.removeHandler(PRINCIPAL_LANE_STATUS_DELEGATE_CHANNEL)
      ipcMain.removeHandler(PRINCIPAL_LANE_STATUS_REFRESH_HOST_CHANNEL)
      setLaneDelegationDesktopStatusListener(null)
    }
  }

  mainWindow.on('closed', dispose)
  return dispose
}
