import { useEffect, useState, type ReactElement } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import type { ClaudeLaneDelegationLease } from '../../../../shared/claude-lane-lease'

function formatSince(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

/**
 * One delegation lease THIS desktop holds (S9 §2e): the account it pushed to a host, shown as the
 * Q3 friendly name it can edit in place, with the host, the person and when it was delegated, plus
 * the release action that gives the account back. The friendly name is persisted where the lease
 * lives, so it survives a reconnect.
 */
export function AccountLaneLeaseRow({
  lease,
  personLabel,
  busy,
  onRename,
  onRelease
}: {
  lease: ClaudeLaneDelegationLease
  personLabel: string
  busy: boolean
  onRename: (friendlyName: string | null) => void
  onRelease: () => void
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(lease.friendlyName ?? '')

  useEffect(() => {
    if (!editing) {
      setDraft(lease.friendlyName ?? '')
    }
  }, [lease.friendlyName, editing])

  const displayName =
    lease.friendlyName ??
    translate('auto.components.settings.AccountLaneLeaseRow.unnamedAccount', 'Delegated account')

  const commit = (): void => {
    const trimmed = draft.trim()
    onRename(trimmed.length > 0 ? trimmed : null)
    setEditing(false)
  }

  return (
    <div
      className="border-border/60 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
      data-testid="account-lane-lease-row"
      data-account-id={lease.accountId}
    >
      <div className="min-w-0 space-y-0.5">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  commit()
                } else if (event.key === 'Escape') {
                  setEditing(false)
                }
              }}
              aria-label={translate(
                'auto.components.settings.AccountLaneLeaseRow.nameLabel',
                'Friendly name for this account'
              )}
              className="h-7 max-w-48 text-sm"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={busy}
              onClick={commit}
              aria-label={translate(
                'auto.components.settings.AccountLaneLeaseRow.saveName',
                'Save name'
              )}
            >
              <Check className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setEditing(false)}
              aria-label={translate(
                'auto.components.settings.AccountLaneLeaseRow.cancelName',
                'Cancel'
              )}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{displayName}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setEditing(true)}
              aria-label={translate(
                'auto.components.settings.AccountLaneLeaseRow.editName',
                'Rename account'
              )}
            >
              <Pencil className="size-3" />
            </Button>
          </div>
        )}
        <div className="text-muted-foreground text-xs">
          {translate(
            'auto.components.settings.AccountLaneLeaseRow.delegatedTo',
            'On {{value0}} for {{value1}} · since {{value2}}',
            { value0: lease.hostId, value1: personLabel, value2: formatSince(lease.since) }
          )}
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={busy}
        onClick={() => onRelease()}
      >
        {translate('auto.components.settings.AccountLaneLeaseRow.release', 'Release')}
      </Button>
    </div>
  )
}
