import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { RuntimeAccessGrant } from '../../../../shared/runtime-access-grants'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import {
  resolveConsentDeviceRows,
  type ConsentSurfaceGrant
} from './principal-consent-surface-rows'
import { describeConsentAuditRow } from './principal-consent-audit-rows'
import {
  startPrincipalConsentSubscription,
  usePrincipalConsentSnapshot
} from './principal-consent-store'
import { usePrincipalLaneStatus } from './principal-lane-status-store'
import { acquirePrincipalLaneStatusSubscription } from './principal-lane-status-subscription'
import { PrincipalConsentDeviceRow } from './PrincipalConsentDeviceRow'
import { PrincipalConsentAuditList } from './PrincipalConsentAuditList'

// Why gated in the renderer AND sender-gated in main: the main bridge already refuses a foreign
// sender (§2a Part 4), but a paired web/remote build must not even paint the affordance — a consent
// tick is a host act, so it is absent on any client that is not the desktop's own frame (§3).
export function isHostConsentSurfaceAvailable(): boolean {
  const isWebClient = (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
  return (
    !isWebClient &&
    typeof window !== 'undefined' &&
    typeof window.api?.principalConsent?.snapshot === 'function'
  )
}

/**
 * The host-only consent surface that sits under the paired-device (Shared Server Access) list: bind
 * each grant to a person, designate that person's one pusher, provision/deprovision the person's
 * credential lane, and read the audit trail that keeps every tick reversible (S9 §2a). It renders
 * nothing on a non-host build.
 */
export function PrincipalConsentSurface({
  grants
}: {
  grants: readonly RuntimeAccessGrant[]
}): ReactElement | null {
  const available = isHostConsentSurfaceAvailable()
  const snapshot = usePrincipalConsentSnapshot()
  const laneStatus = usePrincipalLaneStatus()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [newPersonName, setNewPersonName] = useState('')

  useEffect(() => {
    if (!available) {
      return
    }
    const stopConsent = startPrincipalConsentSubscription(window.api.principalConsent)
    const releaseLane = acquirePrincipalLaneStatusSubscription()
    return () => {
      stopConsent()
      releaseLane()
    }
  }, [available])

  const consentGrants = useMemo<ConsentSurfaceGrant[]>(
    () =>
      grants.map((grant) => ({
        deviceId: grant.deviceId,
        name: grant.name,
        lastSeenAt: grant.lastSeenAt
      })),
    [grants]
  )
  const deviceRows = useMemo(
    () =>
      resolveConsentDeviceRows({
        grants: consentGrants,
        principals: snapshot.principals,
        bindings: snapshot.bindings
      }),
    [consentGrants, snapshot.principals, snapshot.bindings]
  )
  const auditRows = useMemo(
    () =>
      snapshot.audit.map((row) =>
        describeConsentAuditRow(row, {
          principals: snapshot.principals,
          grants: consentGrants
        })
      ),
    [snapshot.audit, snapshot.principals, consentGrants]
  )
  const provisionedLaneIds = useMemo(
    () => new Set(laneStatus.lanes.map((lane) => lane.principalId)),
    [laneStatus.lanes]
  )

  if (!available) {
    return null
  }

  const runWrite = async (key: string, write: () => Promise<unknown>): Promise<void> => {
    setBusyKey(key)
    try {
      await write()
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.PrincipalConsentSurface.writeFailed',
          'Consent update failed.'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      setBusyKey(null)
    }
  }

  const createPerson = async (): Promise<void> => {
    const displayName = newPersonName.trim()
    if (!displayName) {
      return
    }
    await runWrite('create-person', async () => {
      await window.api.principalConsent.createPrincipal(displayName)
      setNewPersonName('')
    })
  }

  return (
    <section
      className="border-border/60 mt-4 space-y-3 border-t pt-4"
      data-testid="principal-consent-surface"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          {translate('auto.components.settings.PrincipalConsentSurface.title', 'Credential lanes')}
        </h3>
        <p className="text-muted-foreground text-xs">
          {translate(
            'auto.components.settings.PrincipalConsentSurface.subtitle',
            'Bind each shared-access device to a person so Orca runs its Claude terminals under that person’s own account. Only a person’s designated device pushes their credential.'
          )}
        </p>
      </div>

      {deviceRows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {translate(
            'auto.components.settings.PrincipalConsentSurface.noDevices',
            'No shared-access devices to bind yet.'
          )}
        </p>
      ) : (
        <div className="space-y-2">
          {deviceRows.map((row) => (
            <PrincipalConsentDeviceRow
              key={row.deviceId}
              row={row}
              people={snapshot.principals}
              busyKey={busyKey}
              laneProvisioned={
                row.boundPrincipal ? provisionedLaneIds.has(row.boundPrincipal.principalId) : false
              }
              laneState={
                row.boundPrincipal
                  ? (laneStatus.lanes.find(
                      (lane) => lane.principalId === row.boundPrincipal?.principalId
                    )?.laneState ?? null)
                  : null
              }
              provisioningPlatformGate={snapshot.provisioningPlatformGate}
              onBind={(principalId) =>
                runWrite(`bind:${row.deviceId}`, () =>
                  window.api.principalConsent.bind(row.deviceId, principalId)
                )
              }
              onRebind={(principalId) =>
                runWrite(`bind:${row.deviceId}`, () =>
                  window.api.principalConsent.rebind(row.deviceId, principalId)
                )
              }
              onUnbind={() =>
                runWrite(`bind:${row.deviceId}`, () =>
                  window.api.principalConsent.unbind(row.deviceId)
                )
              }
              onDesignate={(principalId) =>
                runWrite(`designate:${row.deviceId}`, () =>
                  window.api.principalConsent.designatePusher(principalId, row.deviceId)
                )
              }
              onProvision={(principalId, acceptUnverifiedPlatform) =>
                runWrite(`provision:${principalId}`, () =>
                  window.api.principalConsent.provision(
                    principalId,
                    acceptUnverifiedPlatform ? { acceptUnverifiedPlatform: true } : undefined
                  )
                )
              }
              onDeprovision={(principalId) =>
                runWrite(`provision:${principalId}`, () =>
                  window.api.principalConsent.deprovision(principalId)
                )
              }
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={newPersonName}
          onChange={(event) => setNewPersonName(event.target.value)}
          placeholder={translate(
            'auto.components.settings.PrincipalConsentSurface.newPersonPlaceholder',
            'Add a person…'
          )}
          aria-label={translate(
            'auto.components.settings.PrincipalConsentSurface.newPersonLabel',
            'New person name'
          )}
          className="h-8 max-w-56 text-sm"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busyKey === 'create-person' || newPersonName.trim().length === 0}
          onClick={() => void createPerson()}
        >
          {translate('auto.components.settings.PrincipalConsentSurface.addPerson', 'Add person')}
        </Button>
      </div>

      <PrincipalConsentAuditList rows={auditRows} />
    </section>
  )
}
