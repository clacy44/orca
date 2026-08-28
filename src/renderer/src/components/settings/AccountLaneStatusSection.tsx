import { useEffect, useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import type { PrincipalLaneStatusRow } from '../../../../shared/principal-lane-status-ipc'
import { usePrincipalLaneStatus } from './principal-lane-status-store'
import { acquirePrincipalLaneStatusSubscription } from './principal-lane-status-subscription'
import { isHostConsentSurfaceAvailable } from './PrincipalConsentSurface'
import { LaneLoginSection } from './LaneLoginSection'
import { RemoteHostRow } from './RemoteHostRow'
import { laneStateBadge } from './lane-state-badge'

function LaneRow({ lane }: { lane: PrincipalLaneStatusRow }): ReactElement {
  const badge = laneStateBadge(lane.laneState)
  // §2e: a designated pusher whose lane never loaded is the mis-designation case — name it so the
  // human re-ticks, rather than leaving an unexplained empty lane.
  const noPush = lane.laneState === 'absent' && lane.delegatedGrantId !== null
  return (
    <div
      className="border-border/60 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
      data-testid="account-lane-row"
      data-principal-id={lane.principalId}
    >
      <div className="min-w-0 space-y-0.5">
        <span className="truncate text-sm font-medium">{lane.displayName}</span>
        {noPush ? (
          <div className="text-muted-foreground text-xs" data-testid="lane-no-push">
            {translate(
              'auto.components.settings.AccountLaneStatusSection.noLogin',
              'Lane designated to {{value0}}; no login completed yet.',
              { value0: lane.delegatedGrantId ?? '' }
            )}
          </div>
        ) : null}
      </div>
      <Badge variant={badge.variant} className="shrink-0" data-lane-state={lane.laneState}>
        {badge.label}
      </Badge>
    </div>
  )
}

/**
 * The AccountsPane per-lane section (S9 §2e/§2h, rev 32's credential-source re-basing): this
 * desktop's provisioned Claude credential lanes with their live residency, and one discoverability
 * row per paired remote environment. Host-only: it renders nothing on a non-host build, exactly as
 * the consent surface does. Rev 32 deletes the push model with it (§10(g)): there is no more
 * delegation lease to release or rename, and a remote lane's own account list is loaded through
 * `LaneLoginSection`'s login quartet rather than pushed from here.
 */
export function AccountLaneStatusSection(): ReactElement | null {
  const available = isHostConsentSurfaceAvailable()
  const status = usePrincipalLaneStatus()
  const [refreshingEnvironmentId, setRefreshingEnvironmentId] = useState<string | null>(null)

  useEffect(() => {
    if (!available) {
      return
    }
    return acquirePrincipalLaneStatusSubscription()
  }, [available])

  if (!available) {
    return null
  }
  // Discoverability follow-up (release audit): the section used to vanish whenever nothing was
  // ready to sign in, which is exactly the state a not-yet-designated device is stuck in. Any
  // remote environment — ready or not — earns the section a place to say why.
  if (status.lanes.length === 0 && status.remoteHosts.length === 0) {
    return null
  }

  const runRefresh = async (environmentId: string): Promise<void> => {
    setRefreshingEnvironmentId(environmentId)
    try {
      const { refreshed } = await window.api.principalLaneStatus.refreshHost(environmentId)
      if (!refreshed) {
        toast.error(
          translate(
            'auto.components.settings.AccountLaneStatusSection.refreshFailed',
            'Refresh failed.'
          )
        )
      }
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.AccountLaneStatusSection.refreshFailed',
          'Refresh failed.'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      setRefreshingEnvironmentId(null)
    }
  }

  return (
    <section
      className="border-border/60 space-y-3 border-t pt-4"
      data-testid="account-lane-status-section"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          {translate(
            'auto.components.settings.AccountLaneStatusSection.title',
            'Per-person credential lanes'
          )}
        </h3>
        <p className="text-muted-foreground text-xs" data-testid="lane-operating-rule">
          {translate(
            'auto.components.settings.AccountLaneStatusSection.operatingRule',
            'Each lane holds its own Claude sign-in, independent of any account on this desktop.'
          )}
        </p>
      </div>

      {status.lanes.length > 0 ? (
        <div className="space-y-2">
          {status.lanes.map((lane) => (
            <LaneRow key={lane.principalId} lane={lane} />
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        <h4 className="text-muted-foreground text-xs font-medium">
          {translate(
            'auto.components.settings.AccountLaneStatusSection.remoteTitle',
            'Sign a remote lane in'
          )}
        </h4>
        {status.remoteHosts.length > 0 ? (
          status.remoteHosts.map((row) => (
            <div key={row.environmentId} className="space-y-2">
              <RemoteHostRow
                row={row}
                refreshing={refreshingEnvironmentId === row.environmentId}
                onRefresh={() => void runRefresh(row.environmentId)}
              />
              {/* S9-L2: additive per-host lane-login UI, capability-gated on agent.identity-lanes.v2.
                  The remote-host row carries no principal binding on today's wire, so the host's own
                  label stands in for both until L1 widens `PrincipalLaneStatusRemoteHostRow`. */}
              <LaneLoginSection
                environmentId={row.environmentId}
                principalLabel={row.label}
                laneLabel={row.label}
              />
            </div>
          ))
        ) : (
          <p className="text-muted-foreground text-xs" data-testid="remote-hosts-empty">
            {translate(
              'auto.components.settings.AccountLaneStatusSection.noRemoteHosts',
              'No remote Orca environments are paired yet.'
            )}
          </p>
        )}
      </div>
    </section>
  )
}
