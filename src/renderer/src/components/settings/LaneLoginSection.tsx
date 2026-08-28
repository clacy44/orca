// S9-L2 (design rev 38 §2l/§3/§6): per remote-host lane-login UI — "Sign this lane into an
// account", the lane's own account list (active marker, Switch, Remove) and Log out. Capability-
// gated on `agent.identity-lanes.v2`: hidden with "update the host" when the host does not
// advertise it, exactly as the rest of this file's siblings gate on v1.
import { useEffect, useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { LaneAccountListRow } from './LaneAccountListRow'
import { LaneLoginDialog } from './LaneLoginDialog'
import { startLaneLoginSubscription, useLaneLogin } from './lane-login-store'

export function LaneLoginSection({
  environmentId,
  principalLabel,
  laneLabel
}: {
  environmentId: string
  principalLabel: string
  laneLabel: string
}): ReactElement | null {
  const snapshot = useLaneLogin(environmentId)
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    // Guarded: an older preload bundle (or a test double that only stubs the APIs it exercises)
    // may not carry this lane, and this section must degrade to "nothing shown" rather than throw.
    if (!window.api?.laneLogin) {
      return
    }
    return startLaneLoginSubscription(environmentId, window.api.laneLogin)
  }, [environmentId])

  useEffect(() => {
    if (snapshot.lastLoginError) {
      toast.error(
        translate('auto.components.settings.LaneLoginSection.loginFailed', 'Login failed'),
        { description: snapshot.lastLoginError.message }
      )
    }
  }, [snapshot.lastLoginError])

  if (snapshot.capability === 'unsupported') {
    return (
      <p className="text-muted-foreground text-xs" data-testid="lane-login-unsupported">
        {translate(
          'auto.components.settings.LaneLoginSection.updateHost',
          'Sign-in for this lane needs a newer host — update the host to use it.'
        )}
      </p>
    )
  }

  const runAccountAction = async (
    action: () => Promise<
      { refused: { code: string; message: string } } | { active: string } | { removed: string }
    >
  ): Promise<void> => {
    const result = await action()
    if (result && typeof result === 'object' && 'refused' in result) {
      const refused = (result as { refused: { message: string } }).refused
      toast.error(
        translate('auto.components.settings.LaneLoginSection.actionFailed', 'Action failed'),
        { description: refused.message }
      )
    }
  }

  const logout = async (): Promise<void> => {
    const result = await window.api.laneLogin.logout(environmentId)
    if ('refused' in result) {
      toast.error(
        translate('auto.components.settings.LaneLoginSection.logoutFailed', 'Log out failed'),
        { description: result.refused.message }
      )
    }
  }

  return (
    <div className="space-y-2" data-testid="lane-login-section">
      {snapshot.accounts.length > 0 ? (
        <div className="space-y-2">
          {snapshot.accounts.map((account) => (
            <LaneAccountListRow
              key={account.laneAccountId}
              account={account}
              onSwitch={() =>
                runAccountAction(() =>
                  window.api.laneLogin.selectAccount(environmentId, account.laneAccountId)
                )
              }
              onRemove={() =>
                runAccountAction(() =>
                  window.api.laneLogin.removeAccount(environmentId, account.laneAccountId)
                )
              }
            />
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDialogOpen(true)}
          data-testid="lane-login-open-dialog-button"
        >
          {translate(
            'auto.components.settings.LaneLoginSection.signIn',
            'Sign this lane into an account'
          )}
        </Button>
        {snapshot.accounts.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void logout()}
            data-testid="lane-login-logout-button"
          >
            {translate('auto.components.settings.LaneLoginSection.logout', 'Log out')}
          </Button>
        ) : null}
      </div>
      <LaneLoginDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        environmentId={environmentId}
        principalLabel={principalLabel}
        laneLabel={laneLabel}
        onCompleted={() => setDialogOpen(false)}
      />
    </div>
  )
}
