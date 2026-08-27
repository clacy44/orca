import { useEffect, useState, type ReactElement } from 'react'
import { translate } from '@/i18n/i18n'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'

/**
 * Owner addendum: delegating the desktop's own active managed account immediately signs it out of
 * every local terminal (rule (iv) clears the runtime file the instant the lease is taken). Asked
 * before that happens, offering either to switch local use elsewhere first or to delegate anyway.
 */
export function DelegateActiveAccountDialog({
  open,
  hostLabel,
  accountLabel,
  otherAccounts,
  defaultSwitchAccountId,
  onCancel,
  onSwitchThenDelegate,
  onDelegateAnyway
}: {
  open: boolean
  hostLabel: string
  accountLabel: string
  otherAccounts: readonly ClaudeManagedAccountSummary[]
  defaultSwitchAccountId: string | null
  onCancel: () => void
  onSwitchThenDelegate: (switchToAccountId: string) => void
  onDelegateAnyway: () => void
}): ReactElement {
  const [switchToAccountId, setSwitchToAccountId] = useState<string | null>(defaultSwitchAccountId)

  useEffect(() => {
    if (open) {
      setSwitchToAccountId(defaultSwitchAccountId)
    }
  }, [open, defaultSwitchAccountId])

  const switchTarget = otherAccounts.find((account) => account.id === switchToAccountId)

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent data-testid="delegate-active-account-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {translate(
              'auto.components.settings.AccountLaneStatusSection.confirmDelegateTitle',
              'Delegate the account you’re using here?'
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {translate(
              'auto.components.settings.AccountLaneStatusSection.confirmDelegateDescription',
              '{{value0}} will be signed out of local terminals while it is loaded on {{value1}}.',
              { value0: accountLabel, value1: hostLabel }
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {otherAccounts.length > 0 ? (
          <Select value={switchToAccountId ?? undefined} onValueChange={setSwitchToAccountId}>
            <SelectTrigger className="w-full" size="sm">
              <SelectValue
                placeholder={translate(
                  'auto.components.settings.AccountLaneStatusSection.switchAccountPlaceholder',
                  'Choose another account…'
                )}
              />
            </SelectTrigger>
            <SelectContent>
              {otherAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            {translate('auto.components.settings.AccountLaneStatusSection.confirmCancel', 'Cancel')}
          </AlertDialogCancel>
          <Button variant="outline" onClick={onDelegateAnyway}>
            {translate(
              'auto.components.settings.AccountLaneStatusSection.delegateAnyway',
              'Delegate anyway'
            )}
          </Button>
          {switchTarget ? (
            <AlertDialogAction onClick={() => onSwitchThenDelegate(switchTarget.id)}>
              {translate(
                'auto.components.settings.AccountLaneStatusSection.switchThenDelegate',
                'Switch local use to {{value0}}',
                { value0: switchTarget.email }
              )}
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
