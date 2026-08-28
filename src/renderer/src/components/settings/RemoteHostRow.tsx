// Lifted out of AccountLaneStatusSection.tsx (hard 400-line `.tsx` ceiling, S9-L2 extraction): the
// per-REMOTE-environment row and its Refresh control. Rev 32 deletes the account select/Delegate
// controls with the push model (§10(g)) — signing a remote lane in is `LaneLoginSection`'s job,
// rendered beside this row rather than folded into it.
import type { ReactElement } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import type { PrincipalLaneStatusRemoteHostRow } from '../../../../shared/principal-lane-status-ipc'
import { laneStateBadge } from './lane-state-badge'

/** The Refresh control every remote-host row carries, regardless of its state. */
function RefreshHostButton({
  busy,
  onRefresh
}: {
  busy: boolean
  onRefresh: () => void
}): ReactElement {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={onRefresh}
      data-testid="refresh-host-button"
      aria-label={translate(
        'auto.components.settings.AccountLaneStatusSection.refreshHost',
        'Refresh'
      )}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
    </Button>
  )
}

/**
 * One row per REMOTE Orca environment (release-audit follow-up), whatever this desktop's grant on
 * it currently is: still being checked, connected but not designated, too old to support lanes, or
 * designated and ready to sign in. Every state carries the same Refresh action, so a stale row is
 * never a dead end — the whole point of this section always rendering rather than vanishing.
 */
export function RemoteHostRow({
  row,
  refreshing,
  onRefresh
}: {
  row: PrincipalLaneStatusRemoteHostRow
  refreshing: boolean
  onRefresh: () => void
}): ReactElement {
  return (
    <div
      className="border-border/60 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
      data-testid="remote-host-row"
      data-environment-id={row.environmentId}
      data-host-state={row.state}
    >
      <div className="min-w-0 space-y-0.5">
        <span className="truncate text-sm font-medium">{row.label}</span>
        <RemoteHostRowStatus row={row} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <RefreshHostButton busy={refreshing} onRefresh={onRefresh} />
      </div>
    </div>
  )
}

function RemoteHostRowStatus({ row }: { row: PrincipalLaneStatusRemoteHostRow }): ReactElement {
  if (row.state === 'checking') {
    return (
      <div className="text-muted-foreground text-xs" data-testid="remote-host-checking">
        {translate('auto.components.settings.AccountLaneStatusSection.checking', 'Checking…')}
      </div>
    )
  }
  if (row.state === 'unreachable') {
    return (
      <div className="text-muted-foreground text-xs" data-testid="remote-host-unreachable">
        {translate(
          'auto.components.settings.AccountLaneStatusSection.unreachable',
          '{{value0}} is disconnected — reconnect it to check for a lane.',
          { value0: row.label }
        )}
      </div>
    )
  }
  if (row.state === 'unsupported') {
    return (
      <div className="text-muted-foreground text-xs" data-testid="remote-host-unsupported">
        {translate(
          'auto.components.settings.AccountLaneStatusSection.unsupported',
          'Lanes not supported — update the host.'
        )}
      </div>
    )
  }
  if (row.state === 'not-designated') {
    return (
      <div className="text-muted-foreground text-xs" data-testid="remote-host-not-designated">
        {translate(
          'auto.components.settings.AccountLaneStatusSection.notDesignated',
          'This device is not designated for any person on {{value0}} (run `orca lane designate` on the host).',
          { value0: row.label }
        )}
      </div>
    )
  }
  const badge = laneStateBadge(row.laneState)
  return (
    <Badge variant={badge.variant} className="shrink-0" data-lane-state={row.laneState}>
      {badge.label}
    </Badge>
  )
}
