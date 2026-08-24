import type { ReactElement } from 'react'
import { Check } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { RuntimeTerminalLaneState } from '../../../../shared/runtime-types'
import type { ConsentDeviceRow } from './principal-consent-surface-rows'
import type { ConsentSurfacePrincipal } from './principal-consent-surface-rows'

function laneStateLabel(state: RuntimeTerminalLaneState): string {
  switch (state) {
    case 'loaded':
      return translate('auto.components.settings.PrincipalConsentDeviceRow.laneLoaded', 'loaded')
    case 'absent':
      return translate('auto.components.settings.PrincipalConsentDeviceRow.laneAbsent', 'absent')
    case 'reauth-required':
      return translate(
        'auto.components.settings.PrincipalConsentDeviceRow.laneReauth',
        'reauth required'
      )
  }
}

/**
 * One shared-access device on the consent surface (S9 §2a): who it belongs to (bind / rebind /
 * unbind), whether it is that person's designated pusher (one tick), and the person's credential
 * lane provisioning. The eligibility of each action is decided by the pure resolver on `row`, never
 * here — this only paints and calls back.
 */
export function PrincipalConsentDeviceRow({
  row,
  people,
  busyKey,
  laneProvisioned,
  laneState,
  onBind,
  onRebind,
  onUnbind,
  onDesignate,
  onProvision,
  onDeprovision
}: {
  row: ConsentDeviceRow
  people: readonly ConsentSurfacePrincipal[]
  busyKey: string | null
  laneProvisioned: boolean
  laneState: RuntimeTerminalLaneState | null
  onBind: (principalId: string) => void
  onRebind: (principalId: string) => void
  onUnbind: () => void
  onDesignate: (principalId: string) => void
  onProvision: (principalId: string) => void
  onDeprovision: (principalId: string) => void
}): ReactElement {
  const bindBusy = busyKey === `bind:${row.deviceId}`
  const designateBusy = busyKey === `designate:${row.deviceId}`
  const bound = row.boundPrincipal
  const provisionBusy = bound ? busyKey === `provision:${bound.principalId}` : false

  return (
    <div
      className="border-border/60 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
      data-testid="consent-device-row"
      data-device-id={row.deviceId}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{row.name}</span>
          {row.isDesignatedPusher ? (
            <Badge variant="secondary" className="shrink-0">
              {translate('auto.components.settings.PrincipalConsentDeviceRow.pusher', 'Pusher')}
            </Badge>
          ) : null}
          {!row.everConnected ? (
            <span className="text-muted-foreground shrink-0 text-xs">
              {translate(
                'auto.components.settings.PrincipalConsentDeviceRow.neverConnected',
                'Never connected'
              )}
            </span>
          ) : null}
        </div>
        <div className="text-muted-foreground text-xs">
          {bound
            ? translate(
                'auto.components.settings.PrincipalConsentDeviceRow.boundTo',
                'Belongs to {{value0}}',
                { value0: bound.displayName }
              )
            : translate(
                'auto.components.settings.PrincipalConsentDeviceRow.unbound',
                'Not bound to a person'
              )}
          {bound && laneProvisioned && laneState ? (
            <span data-testid="consent-lane-state">
              {' · '}
              {translate(
                'auto.components.settings.PrincipalConsentDeviceRow.laneStatus',
                'lane {{value0}}',
                { value0: laneStateLabel(laneState) }
              )}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {row.canBind && people.length > 0 ? (
          <Select disabled={bindBusy} onValueChange={(principalId) => onBind(principalId)}>
            <SelectTrigger
              size="sm"
              className="h-8 w-40"
              aria-label={translate(
                'auto.components.settings.PrincipalConsentDeviceRow.bindLabel',
                'Bind {{value0}} to a person',
                { value0: row.name }
              )}
            >
              <SelectValue
                placeholder={translate(
                  'auto.components.settings.PrincipalConsentDeviceRow.bindPlaceholder',
                  'Bind to person…'
                )}
              />
            </SelectTrigger>
            <SelectContent>
              {people.map((person) => (
                <SelectItem key={person.principalId} value={person.principalId}>
                  {person.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {bound ? (
          <>
            <Select
              disabled={bindBusy}
              value={bound.principalId}
              onValueChange={(principalId) => {
                if (principalId !== bound.principalId) {
                  onRebind(principalId)
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="h-8 w-40"
                aria-label={translate(
                  'auto.components.settings.PrincipalConsentDeviceRow.rebindLabel',
                  'Change the person {{value0}} belongs to',
                  { value0: row.name }
                )}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {people.map((person) => (
                  <SelectItem key={person.principalId} value={person.principalId}>
                    {person.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              type="button"
              variant={row.isDesignatedPusher ? 'secondary' : 'outline'}
              size="sm"
              disabled={designateBusy || row.isDesignatedPusher}
              onClick={() => onDesignate(bound.principalId)}
            >
              {row.isDesignatedPusher ? <Check className="size-3.5" aria-hidden="true" /> : null}
              {row.isDesignatedPusher
                ? translate(
                    'auto.components.settings.PrincipalConsentDeviceRow.isPusher',
                    'Is pusher'
                  )
                : translate(
                    'auto.components.settings.PrincipalConsentDeviceRow.designate',
                    'Set as pusher'
                  )}
            </Button>

            <Button
              type="button"
              variant={laneProvisioned ? 'outline' : 'default'}
              size="sm"
              disabled={provisionBusy}
              onClick={() =>
                laneProvisioned ? onDeprovision(bound.principalId) : onProvision(bound.principalId)
              }
            >
              {laneProvisioned
                ? translate(
                    'auto.components.settings.PrincipalConsentDeviceRow.deprovision',
                    'Deprovision lane'
                  )
                : translate(
                    'auto.components.settings.PrincipalConsentDeviceRow.provision',
                    'Provision lane'
                  )}
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={bindBusy}
              onClick={() => onUnbind()}
            >
              {translate(
                'auto.components.settings.PrincipalConsentDeviceRow.unbindAction',
                'Unbind'
              )}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}
