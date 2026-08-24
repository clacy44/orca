import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import type { RuntimeTerminalLaneState } from '../../../../shared/runtime-types'
import type {
  PrincipalLaneStatusDelegableHost,
  PrincipalLaneStatusRow
} from '../../../../shared/principal-lane-status-ipc'
import { usePrincipalLaneStatus } from './principal-lane-status-store'
import { acquirePrincipalLaneStatusSubscription } from './principal-lane-status-subscription'
import { isHostConsentSurfaceAvailable } from './PrincipalConsentSurface'
import { AccountLaneLeaseRow } from './AccountLaneLeaseRow'

// The lane residency states this section paints. It is the shipped `RuntimeTerminalLaneState`
// (loaded | absent | reauth-required) PLUS `restart-required` — §2h's degraded value the wire does
// not carry yet (§10(e)) — so the badge is correct the moment that value ships.
type LaneStateForDisplay = RuntimeTerminalLaneState | 'restart-required'

function laneStateBadge(state: LaneStateForDisplay): {
  label: string
  variant: 'default' | 'secondary' | 'destructive' | 'outline'
} {
  switch (state) {
    case 'loaded':
      return {
        label: translate('auto.components.settings.AccountLaneStatusSection.loaded', 'Loaded'),
        variant: 'default'
      }
    case 'absent':
      return {
        label: translate('auto.components.settings.AccountLaneStatusSection.absent', 'Absent'),
        variant: 'outline'
      }
    case 'reauth-required':
      return {
        label: translate(
          'auto.components.settings.AccountLaneStatusSection.reauth',
          'Reauth required'
        ),
        variant: 'destructive'
      }
    case 'restart-required':
      return {
        label: translate(
          'auto.components.settings.AccountLaneStatusSection.restart',
          'Restart required'
        ),
        variant: 'secondary'
      }
  }
}

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

/** One paired, reachable host this desktop's grant is designated to push onto (B3). */
function DelegateHostRow({
  host,
  accounts,
  selectedAccountId,
  onSelectAccount,
  busy,
  onDelegate
}: {
  host: PrincipalLaneStatusDelegableHost
  accounts: readonly ClaudeManagedAccountSummary[]
  selectedAccountId: string | null
  onSelectAccount: (accountId: string) => void
  busy: boolean
  onDelegate: () => void
}): ReactElement {
  const badge = laneStateBadge(host.laneState)
  return (
    <div
      className="border-border/60 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
      data-testid="delegate-host-row"
      data-environment-id={host.environmentId}
    >
      <div className="min-w-0 space-y-0.5">
        <span className="truncate text-sm font-medium">{host.label}</span>
        <Badge variant={badge.variant} className="shrink-0" data-lane-state={host.laneState}>
          {badge.label}
        </Badge>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Select value={selectedAccountId ?? undefined} onValueChange={onSelectAccount}>
          <SelectTrigger className="h-8 w-[200px]" size="sm">
            <SelectValue
              placeholder={translate(
                'auto.components.settings.AccountLaneStatusSection.delegateAccountPlaceholder',
                'Choose account…'
              )}
            />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !selectedAccountId}
          onClick={onDelegate}
          data-testid="delegate-host-button"
        >
          {translate(
            'auto.components.settings.AccountLaneStatusSection.delegateButton',
            'Delegate'
          )}
        </Button>
      </div>
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
  if (
    status.lanes.length === 0 &&
    status.delegationLeases.length === 0 &&
    status.delegableHosts.length === 0
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

      {status.delegableHosts.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-muted-foreground text-xs font-medium">
            {translate(
              'auto.components.settings.AccountLaneStatusSection.delegateTitle',
              'Load an account onto a host'
            )}
          </h4>
          {status.delegableHosts.map((host) => (
            <DelegateHostRow
              key={host.environmentId}
              host={host}
              accounts={claudeAccounts}
              selectedAccountId={selectedAccountByHost[host.environmentId] ?? null}
              onSelectAccount={(accountId) =>
                setSelectedAccountByHost((prev) => ({ ...prev, [host.environmentId]: accountId }))
              }
              busy={busyAccountId === host.environmentId}
              onDelegate={() => {
                const accountId = selectedAccountByHost[host.environmentId]
                if (!accountId) {
                  return
                }
                void runWrite(host.environmentId, () =>
                  window.api.principalLaneStatus.delegateAccountToHost(
                    accountId,
                    host.environmentId
                  )
                )
              }}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}
