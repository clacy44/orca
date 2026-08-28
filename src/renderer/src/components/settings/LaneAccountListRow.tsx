// S9-L2 (design rev 38 §2c/§3 row 9): one of the lane's own logins — an active-account marker,
// a Switch action (any grant bound to the principal may call this, including the phone, because a
// switch moves no secret) and a Remove action (refused on the active login unless logging out).
import { useState, type ReactElement } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import type { LaneAccountRow } from '../../../../shared/claude-lane-login-rpc'

export function LaneAccountListRow({
  account,
  onSwitch,
  onRemove
}: {
  account: LaneAccountRow
  onSwitch: () => Promise<void>
  onRemove: () => Promise<void>
}): ReactElement {
  const [busy, setBusy] = useState<'switch' | 'remove' | null>(null)

  const run = async (kind: 'switch' | 'remove', action: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    try {
      await action()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="border-border/60 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
      data-testid="lane-account-row"
      data-lane-account-id={account.laneAccountId}
      data-active={account.active}
    >
      <div className="min-w-0 space-y-0.5">
        <span className="truncate text-sm font-medium">{account.label ?? account.email}</span>
        <div className="text-muted-foreground truncate text-xs">{account.email}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {account.active ? (
          <Badge variant="default" data-testid="lane-account-active-badge">
            {translate('auto.components.settings.LaneAccountListRow.active', 'Active')}
          </Badge>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run('switch', onSwitch)}
            data-testid="lane-account-switch-button"
          >
            {busy === 'switch' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              translate('auto.components.settings.LaneAccountListRow.switch', 'Switch')
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null || account.active}
          onClick={() => void run('remove', onRemove)}
          data-testid="lane-account-remove-button"
          aria-label={translate('auto.components.settings.LaneAccountListRow.remove', 'Remove')}
        >
          {busy === 'remove' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            translate('auto.components.settings.LaneAccountListRow.remove', 'Remove')
          )}
        </Button>
      </div>
    </div>
  )
}
