// The host-only lane-status seam (S9 §2e/§2h, §10(d)): the AccountsPane section's read of THIS
// desktop's own principal-lane residency and its delegation leases. Sender-gated exactly as the
// consent and presence lanes are — a non-host frame gets the empty snapshot, never a roster. The
// desktop's own lanes have no paired-client wire; a REMOTE host's lane status is a separate,
// pre-existing `accounts.lane.status` RPC path and is not this lane's concern.
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { ClaudeLaneDelegationLease } from '../../shared/claude-lane-lease'
import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import {
  PRINCIPAL_LANE_STATUS_CHANGED_CHANNEL,
  PRINCIPAL_LANE_STATUS_GET_CHANNEL,
  type PrincipalLaneStatusSnapshot
} from '../../shared/principal-lane-status-ipc'
import { getLaneDelegationLeaseStore } from '../claude-accounts/lane-delegation-lease'
import { resolveLaneResidencyState } from '../claude-accounts/principal-lane-residency'
import { getPrincipalLaneConsentService } from '../runtime/principal-lane-consent-service'

const EMPTY_SNAPSHOT: PrincipalLaneStatusSnapshot = { lanes: [], delegationLeases: [] }

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
    delegationLeases: listDelegationLeases()
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

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    broadcasters.delete(broadcast)
    if (activeRegistrationToken === token) {
      ipcMain.removeHandler(PRINCIPAL_LANE_STATUS_GET_CHANNEL)
    }
  }

  mainWindow.on('closed', dispose)
  return dispose
}
