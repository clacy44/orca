// The host-only consent seam (S9 §2a, §10(d) Part 4's IPC arm). `authorizeHostConsent` already
// refuses any paired grant by `clientKind`, but the host renderer calls in-process with NO
// clientKind — so the authority alone would admit ANYONE who reached this channel. The door that
// closes that is the sender check every privileged per-window channel uses (terminal-presence.ts):
// only the desktop's own main frame may bind a device to a person, designate a pusher, or
// provision a lane. Anything else is refused before a `HostConsent` is ever constructed.
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  PRINCIPAL_CONSENT_BIND_CHANNEL,
  PRINCIPAL_CONSENT_CHANGED_CHANNEL,
  PRINCIPAL_CONSENT_CREATE_PRINCIPAL_CHANNEL,
  PRINCIPAL_CONSENT_DEPROVISION_CHANNEL,
  PRINCIPAL_CONSENT_DESIGNATE_CHANNEL,
  PRINCIPAL_CONSENT_PROVISION_CHANNEL,
  PRINCIPAL_CONSENT_REBIND_CHANNEL,
  PRINCIPAL_CONSENT_SNAPSHOT_CHANNEL,
  PRINCIPAL_CONSENT_UNBIND_CHANNEL,
  type PrincipalConsentBindRequest,
  type PrincipalConsentBindResult,
  type PrincipalConsentCreatePrincipalRequest,
  type PrincipalConsentCreatePrincipalResult,
  type PrincipalConsentDeprovisionResult,
  type PrincipalConsentDesignateRequest,
  type PrincipalConsentDesignateResult,
  type PrincipalConsentPrincipalRequest,
  type PrincipalConsentProvisionRequest,
  type PrincipalConsentProvisionResult,
  type PrincipalConsentSnapshot,
  type PrincipalConsentUnbindRequest,
  type PrincipalConsentUnbindResult
} from '../../shared/principal-consent-ipc'
import { authorizeHostConsent } from '../runtime/principal-consent-authority'
import { notifyPrincipalLaneStatusChanged } from './principal-lane-status-bridge'
import {
  getPrincipalLaneConsentService,
  type PrincipalLaneConsentService
} from '../runtime/principal-lane-consent-service'

const EMPTY_SNAPSHOT: PrincipalConsentSnapshot = {
  principals: [],
  bindings: [],
  audit: [],
  provisioningPlatformGate: null
}

export type PrincipalConsentBridgeOptions = {
  /** Injected in tests; defaults to the process-wide attached surface. */
  resolveService?: () => PrincipalLaneConsentService | null
}

// Why a token: macOS keeps the process alive with no window, so a later window re-registers these
// channels; the older window's 'closed' must not remove the newer registration's handlers.
let activeRegistrationToken = 0

const WRITE_CHANNELS = [
  PRINCIPAL_CONSENT_CREATE_PRINCIPAL_CHANNEL,
  PRINCIPAL_CONSENT_BIND_CHANNEL,
  PRINCIPAL_CONSENT_UNBIND_CHANNEL,
  PRINCIPAL_CONSENT_REBIND_CHANNEL,
  PRINCIPAL_CONSENT_DESIGNATE_CHANNEL,
  PRINCIPAL_CONSENT_PROVISION_CHANNEL,
  PRINCIPAL_CONSENT_DEPROVISION_CHANNEL
] as const
const ALL_CHANNELS = [PRINCIPAL_CONSENT_SNAPSHOT_CHANNEL, ...WRITE_CHANNELS] as const

export function registerPrincipalConsentBridge(
  mainWindow: BrowserWindow,
  options: PrincipalConsentBridgeOptions = {}
): () => void {
  const token = ++activeRegistrationToken
  const resolveService = options.resolveService ?? getPrincipalLaneConsentService
  let disposed = false

  const isMainWindowSender = (event: IpcMainInvokeEvent): boolean =>
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed() &&
    event.sender === mainWindow.webContents

  // Why refuse rather than answer empty on a write: a read from an unknown sender leaks nothing, but a
  // write is a consent act, so a non-host sender must be turned away by name, never silently ignored.
  const requireHostSender = (event: IpcMainInvokeEvent): void => {
    if (!isMainWindowSender(event)) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.consent_caller_not_local',
        'Binding a device to a person, designating who pushes, and provisioning a credential lane are decisions made at the host machine, in Orca on the host.'
      )
    }
  }

  const requireService = (event: IpcMainInvokeEvent): PrincipalLaneConsentService => {
    requireHostSender(event)
    const service = resolveService()
    if (!service) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.consent_caller_not_local',
        'Per-person Claude credential lanes are not enabled on this host yet, so there is nothing to bind or provision.'
      )
    }
    return service
  }

  const buildSnapshot = (service: PrincipalLaneConsentService): PrincipalConsentSnapshot => {
    const principals = service.listPrincipals()
    return {
      principals: principals.map((principal) => ({
        principalId: principal.principalId,
        displayName: principal.displayName,
        delegatedGrantId: principal.delegatedGrantId ?? null
      })),
      // Why derived from `boundDeviceIds` and not a raw binding list: that reader already drops a
      // binding whose grant was revoked, so a stale row can never reach the surface as a live one.
      bindings: principals.flatMap((principal) =>
        service.boundDeviceIds(principal.principalId).map((deviceId) => ({
          deviceId,
          principalId: principal.principalId
        }))
      ),
      audit: service.listAudit().map((row) => ({ ...row })),
      provisioningPlatformGate: service.provisioningPlatformGate
    }
  }

  const broadcastChanged = (service: PrincipalLaneConsentService): void => {
    if (disposed || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      return
    }
    mainWindow.webContents.send(PRINCIPAL_CONSENT_CHANGED_CHANNEL, buildSnapshot(service))
  }

  // Reads: a non-host sender leaks nothing, so it gets the empty snapshot, not a refusal.
  ipcMain.removeHandler(PRINCIPAL_CONSENT_SNAPSHOT_CHANNEL)
  ipcMain.handle(PRINCIPAL_CONSENT_SNAPSHOT_CHANNEL, (event): PrincipalConsentSnapshot => {
    if (!isMainWindowSender(event)) {
      return EMPTY_SNAPSHOT
    }
    const service = resolveService()
    return service ? buildSnapshot(service) : EMPTY_SNAPSHOT
  })

  ipcMain.removeHandler(PRINCIPAL_CONSENT_CREATE_PRINCIPAL_CHANNEL)
  ipcMain.handle(
    PRINCIPAL_CONSENT_CREATE_PRINCIPAL_CHANNEL,
    (
      event,
      request: PrincipalConsentCreatePrincipalRequest
    ): PrincipalConsentCreatePrincipalResult => {
      const service = requireService(event)
      const principal = service.createPrincipal(authorizeHostConsent({}), request.displayName)
      broadcastChanged(service)
      return { principalId: principal.principalId, displayName: principal.displayName }
    }
  )

  ipcMain.removeHandler(PRINCIPAL_CONSENT_BIND_CHANNEL)
  ipcMain.handle(
    PRINCIPAL_CONSENT_BIND_CHANNEL,
    (event, request: PrincipalConsentBindRequest): PrincipalConsentBindResult => {
      const service = requireService(event)
      service.bindGrant(authorizeHostConsent({}), request.deviceId, request.principalId)
      broadcastChanged(service)
      return { bound: true }
    }
  )

  ipcMain.removeHandler(PRINCIPAL_CONSENT_UNBIND_CHANNEL)
  ipcMain.handle(
    PRINCIPAL_CONSENT_UNBIND_CHANNEL,
    (event, request: PrincipalConsentUnbindRequest): PrincipalConsentUnbindResult => {
      const service = requireService(event)
      const unbound = service.unbindGrant(authorizeHostConsent({}), request.deviceId)
      broadcastChanged(service)
      return { unbound }
    }
  )

  ipcMain.removeHandler(PRINCIPAL_CONSENT_REBIND_CHANNEL)
  ipcMain.handle(
    PRINCIPAL_CONSENT_REBIND_CHANNEL,
    (event, request: PrincipalConsentBindRequest): PrincipalConsentBindResult => {
      const service = requireService(event)
      service.rebindGrant(authorizeHostConsent({}), request.deviceId, request.principalId)
      broadcastChanged(service)
      return { bound: true }
    }
  )

  ipcMain.removeHandler(PRINCIPAL_CONSENT_DESIGNATE_CHANNEL)
  ipcMain.handle(
    PRINCIPAL_CONSENT_DESIGNATE_CHANNEL,
    (event, request: PrincipalConsentDesignateRequest): PrincipalConsentDesignateResult => {
      const service = requireService(event)
      service.designatePusher(authorizeHostConsent({}), request.principalId, request.deviceId)
      broadcastChanged(service)
      return { designatedGrantId: request.deviceId }
    }
  )

  ipcMain.removeHandler(PRINCIPAL_CONSENT_PROVISION_CHANNEL)
  ipcMain.handle(
    PRINCIPAL_CONSENT_PROVISION_CHANNEL,
    (event, request: PrincipalConsentProvisionRequest): PrincipalConsentProvisionResult => {
      const service = requireService(event)
      const lane = service.provisionLane(authorizeHostConsent({}), request.principalId, {
        acceptUnverifiedPlatform: request.acceptUnverifiedPlatform === true
      })
      broadcastChanged(service)
      notifyPrincipalLaneStatusChanged()
      return { provisioned: true, provenanceLabel: lane.provenanceLabel }
    }
  )

  ipcMain.removeHandler(PRINCIPAL_CONSENT_DEPROVISION_CHANNEL)
  ipcMain.handle(
    PRINCIPAL_CONSENT_DEPROVISION_CHANNEL,
    async (
      event,
      request: PrincipalConsentPrincipalRequest
    ): Promise<PrincipalConsentDeprovisionResult> => {
      const service = requireService(event)
      const deprovisioned = await service.deprovisionLane(
        authorizeHostConsent({}),
        request.principalId
      )
      broadcastChanged(service)
      notifyPrincipalLaneStatusChanged()
      return { deprovisioned }
    }
  )

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    if (activeRegistrationToken === token) {
      for (const channel of ALL_CHANNELS) {
        ipcMain.removeHandler(channel)
      }
    }
  }

  mainWindow.on('closed', dispose)
  return dispose
}
