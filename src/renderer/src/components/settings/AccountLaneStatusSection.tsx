import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import type { PrincipalLaneStatusRow } from '../../../../shared/principal-lane-status-ipc'
import { usePrincipalLaneStatus } from './principal-lane-status-store'
import { acquirePrincipalLaneStatusSubscription } from './principal-lane-status-subscription'
import { isHostConsentSurfaceAvailable } from './PrincipalConsentSurface'
import { AccountLaneLeaseRow } from './AccountLaneLeaseRow'
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
              'auto.components.settings.AccountLaneStatusSection.noPush',
              'No push received from {{value0}} yet — re-check the designated device.',
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
 * The AccountsPane per-lane section (S9 §2e/§2h): this desktop's provisioned Claude credential
 * lanes with their live residency, and the delegation leases this desktop holds — each with the
 * host, person and since, a Q3 editable friendly name, and a release action. Host-only: it renders
 * nothing on a non-host build, exactly as the consent surface does.
 */
export function AccountLaneStatusSection(): ReactElement | null {
  const available = isHostConsentSurfaceAvailable()
  const status = usePrincipalLaneStatus()
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)
  const [refreshingEnvironmentId, setRefreshingEnvironmentId] = useState<string | null>(null)
  const [claudeAccounts, setClaudeAccounts] = useState<readonly ClaudeManagedAccountSummary[]>([])
  const [selectedAccountByHost, setSelectedAccountByHost] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!available) {
      return
    }
    return acquirePrincipalLaneStatusSubscription()
  }, [available])

  const hasDelegableHosts = status.delegableHosts.length > 0
  useEffect(() => {
    if (!available || !hasDelegableHosts) {
      return
    }
    let cancelled = false
    void window.api.claudeAccounts.list().then((state) => {
      if (!cancelled) {
        setClaudeAccounts(state.accounts)
      }
    })
    return () => {
      cancelled = true
    }
  }, [available, hasDelegableHosts])

  const personById = useMemo(
    () => new Map(status.lanes.map((lane) => [lane.principalId, lane.displayName])),
    [status.lanes]
  )

  if (!available) {
    return null
  }
  // Discoverability follow-up (release audit): the section used to vanish whenever nothing was
  // ready to delegate onto, which is exactly the state a not-yet-designated device is stuck in.
  // Any remote environment — ready or not — earns the section a place to say why.
  if (
    status.lanes.length === 0 &&
    status.delegationLeases.length === 0 &&
    status.remoteHosts.length === 0
  ) {
    return null
  }

  const runWrite = async (accountId: string, write: () => Promise<unknown>): Promise<void> => {
    setBusyAccountId(accountId)
    try {
      await write()
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.AccountLaneStatusSection.writeFailed',
          'Lane update failed.'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      setBusyAccountId(null)
    }
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
            'One pusher, one puller: while an account is loaded on a shared host, this desktop will not start a local terminal under it. Release it here to use it locally again.'
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

      {status.delegationLeases.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-muted-foreground text-xs font-medium">
            {translate(
              'auto.components.settings.AccountLaneStatusSection.leasesTitle',
              'Accounts you delegated'
            )}
          </h4>
          {status.delegationLeases.map((lease) => (
            <AccountLaneLeaseRow
              key={lease.accountId}
              lease={lease}
              personLabel={personById.get(lease.principalId) ?? lease.principalId}
              busy={busyAccountId === lease.accountId}
              onRename={(friendlyName) =>
                runWrite(lease.accountId, () =>
                  window.api.principalLaneStatus.renameLease(lease.accountId, friendlyName)
                )
              }
              onRelease={() =>
                runWrite(lease.accountId, () =>
                  window.api.principalLaneStatus.releaseLease(lease.accountId)
                )
              }
            />
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        <h4 className="text-muted-foreground text-xs font-medium">
          {translate(
            'auto.components.settings.AccountLaneStatusSection.delegateTitle',
            'Load an account onto a host'
          )}
        </h4>
        {status.remoteHosts.length > 0 ? (
          status.remoteHosts.map((row) => (
            <div key={row.environmentId} className="space-y-2">
              <RemoteHostRow
                row={row}
                accounts={claudeAccounts}
                selectedAccountId={selectedAccountByHost[row.environmentId] ?? null}
                onSelectAccount={(accountId) =>
                  setSelectedAccountByHost((prev) => ({ ...prev, [row.environmentId]: accountId }))
                }
                busy={busyAccountId === row.environmentId}
                refreshing={refreshingEnvironmentId === row.environmentId}
                onDelegate={() => {
                  const accountId = selectedAccountByHost[row.environmentId]
                  if (!accountId) {
                    return
                  }
                  void runWrite(row.environmentId, () =>
                    window.api.principalLaneStatus.delegateAccountToHost(
                      accountId,
                      row.environmentId
                    )
                  )
                }}
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
