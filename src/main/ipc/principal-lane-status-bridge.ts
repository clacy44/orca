// The host-only lane-status seam (S9 §2e/§2h, §10(d)): the AccountsPane section's read of THIS
// desktop's own principal-lane residency and its delegation leases. Sender-gated exactly as the
// consent and presence lanes are — a non-host frame gets the empty snapshot, never a roster. The
// desktop's own lanes have no paired-client wire; a REMOTE host's lane status is a separate,
// pre-existing `accounts.lane.status` RPC path and is not this lane's concern.
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { ClaudeLaneDelegationLease } from '../../shared/claude-lane-lease'
import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL,
  PRINCIPAL_LANE_STATUS_DELEGATE_CHANNEL,
  PRINCIPAL_LANE_STATUS_GET_CHANNEL,
  PRINCIPAL_LANE_STATUS_RELEASE_CHANNEL,
  PRINCIPAL_LANE_STATUS_RENAME_CHANNEL,
  type PrincipalLaneStatusDelegableHost,
  type PrincipalLaneStatusDelegateRequest,
  type PrincipalLaneStatusDelegateResult,
  type PrincipalLaneStatusDelegationLease,
  type PrincipalLaneStatusReleaseRequest,
  type PrincipalLaneStatusReleaseResult,
  type PrincipalLaneStatusRenameRequest,
  type PrincipalLaneStatusRenameResult,
  type PrincipalLaneStatusSnapshot
} from '../../shared/principal-lane-status-ipc'
import {
  delegateAccountToLaneHost,
  listDelegableLaneHosts
} from '../claude-accounts/lane-delegation-desktop-service'
import { getLaneDelegationLeaseStore } from '../claude-accounts/lane-delegation-lease'
import { resolveLaneResidencyState } from '../claude-accounts/principal-lane-residency'
import { reselectClaudeAccountLocallyAfterLaneRelease } from '../claude-accounts/service'
import type { Store } from '../persistence'
import { getPrincipalLaneConsentService } from '../runtime/principal-lane-consent-service'

const EMPTY_SNAPSHOT: PrincipalLaneStatusSnapshot = {
  lanes: [],
  delegationLeases: [],
  delegableHosts: []
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
  /** Injected in tests. Defaults to pushing the named account onto the named host lane. */
  delegateAccount?: (environmentId: string, accountId: string) => Promise<boolean>
  /** Injected in tests. Defaults to this desktop's managed Claude accounts, from `store`. */
  listManagedAccounts?: () => readonly { id: string; email: string }[]
  /** Injected in tests. Defaults to the environment store's names, keyed by id (= a lease's hostId). */
  listEnvironmentNames?: () => readonly { id: string; name: string }[]
  /** Used only for the `listManagedAccounts` default above. */
  store?: Store
  /** Owner addendum. Defaults to re-selecting the account through the desktop's account service. */
  reselectLocally?: (accountId: string) => Promise<boolean>
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
  const delegateAccount =
    options.delegateAccount ??
    ((environmentId: string, accountId: string) =>
      delegateAccountToLaneHost(environmentId, accountId))
  const listManagedAccounts =
    options.listManagedAccounts ?? (() => options.store?.getSettings().claudeManagedAccounts ?? [])
  const listEnvironmentNames =
    options.listEnvironmentNames ?? (() => listEnvironments(app.getPath('userData')))
  const reselectLocally = options.reselectLocally ?? reselectClaudeAccountLocallyAfterLaneRelease

  const isMainWindowSender = (event: IpcMainInvokeEvent): boolean =>
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed() &&
    event.sender === mainWindow.webContents

  const buildLeaseView = (
    lease: ClaudeLaneDelegationLease,
    principals: readonly { principalId: string; displayName: string }[]
  ): PrincipalLaneStatusDelegationLease => ({
    ...lease,
    accountLabel: listManagedAccounts().find((a) => a.id === lease.accountId)?.email ?? null,
    hostLabel: listEnvironmentNames().find((e) => e.id === lease.hostId)?.name ?? null,
    personLabel:
      principals.find((principal) => principal.principalId === lease.principalId)?.displayName ??
      null
  })

  const buildSnapshot = (): PrincipalLaneStatusSnapshot => {
    const principals = listPrincipals()
    return {
      lanes: principals.map((principal) => ({
        principalId: principal.principalId,
        displayName: principal.displayName,
        delegatedGrantId: principal.delegatedGrantId ?? null,
        laneState: resolveLaneState(principal.principalId)
      })),
      delegationLeases: listDelegationLeases().map((lease) => buildLeaseView(lease, principals)),
      delegableHosts: listDelegableHosts()
    }
  }

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
    async (
      event,
      request: PrincipalLaneStatusReleaseRequest
    ): Promise<PrincipalLaneStatusReleaseResult> => {
      if (!isMainWindowSender(event)) {
        return { released: false, reselectedLocally: false }
      }
      // Read BEFORE releasing: `wasLocalActive` lives on the row that's about to be removed.
      const wasLocalActive =
        listDelegationLeases().find((lease) => lease.accountId === request.accountId)
          ?.wasLocalActive === true
      const released = releaseLease(request.accountId)
      const reselectedLocally =
        released && wasLocalActive ? await reselectLocally(request.accountId) : false
      if (released) {
        broadcast()
      }
      return { released, reselectedLocally }
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
    }
  }

  mainWindow.on('closed', dispose)
  return dispose
}
