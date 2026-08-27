import type { ReactElement } from 'react'
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

// The lane residency states this section paints. It is the shipped `RuntimeTerminalLaneState`
// (loaded | absent | reauth-required) PLUS `restart-required` — §2h's degraded value the wire does
// not carry yet (§10(e)) — so the badge is correct the moment that value ships.
type LaneStateForDisplay = RuntimeTerminalLaneState | 'restart-required'

export function laneStateBadge(state: LaneStateForDisplay): {
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

export function LaneRow({ lane }: { lane: PrincipalLaneStatusRow }): ReactElement {
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
export function DelegateHostRow({
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
