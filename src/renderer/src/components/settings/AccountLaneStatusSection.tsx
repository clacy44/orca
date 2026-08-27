import { useEffect, useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import type {
  PrincipalLaneStatusDelegableHost,
  PrincipalLaneStatusDelegateResult,
  PrincipalLaneStatusReleaseResult
} from '../../../../shared/principal-lane-status-ipc'
import { usePrincipalLaneStatus } from './principal-lane-status-store'
import { acquirePrincipalLaneStatusSubscription } from './principal-lane-status-subscription'
import { isHostConsentSurfaceAvailable } from './PrincipalConsentSurface'
import { AccountLaneLeaseRow } from './AccountLaneLeaseRow'
import { DelegateActiveAccountDialog } from './DelegateActiveAccountDialog'
import { DelegateHostRow, LaneRow } from './AccountLaneRows'

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
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null)
  const [selectedAccountByHost, setSelectedAccountByHost] = useState<Record<string, string>>({})
  const [confirmDelegate, setConfirmDelegate] = useState<{
    host: PrincipalLaneStatusDelegableHost
    accountId: string
  } | null>(null)

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
        setActiveAccountId(state.activeAccountId)
      }
    })
    return () => {
      cancelled = true
    }
  }, [available, hasDelegableHosts])

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

  // `isSuccess`/`failureMessage` let a write that RESOLVES with a refusal (e.g. `{ delegated: false }`
  // — the desktop's delegate call never rejects) surface the same refusal-sentence toast as a thrown
  // error, without every caller re-implementing the check.
  const runWrite = async (
    accountId: string,
    write: () => Promise<unknown>,
    options?: {
      isSuccess?: (result: unknown) => boolean
      successMessage?: string | ((result: unknown) => string | null)
      failureMessage?: string
    }
  ): Promise<void> => {
    setBusyAccountId(accountId)
    try {
      const result = await write()
      if (options?.isSuccess && !options.isSuccess(result)) {
        throw new Error(
          options.failureMessage ??
            translate(
              'auto.components.settings.AccountLaneStatusSection.writeFailed',
              'Lane update failed.'
            )
        )
      }
      const successMessage =
        typeof options?.successMessage === 'function'
          ? options.successMessage(result)
          : (options?.successMessage ?? null)
      if (successMessage) {
        toast.success(successMessage)
      }
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

  const doDelegate = (host: PrincipalLaneStatusDelegableHost, accountId: string): void => {
    const accountLabel =
      claudeAccounts.find((account) => account.id === accountId)?.email ?? accountId
    void runWrite(
      host.environmentId,
      () => window.api.principalLaneStatus.delegateAccountToHost(accountId, host.environmentId),
      {
        isSuccess: (result) => (result as PrincipalLaneStatusDelegateResult).delegated === true,
        successMessage: translate(
          'auto.components.settings.AccountLaneStatusSection.delegateSucceeded',
          'Loaded {{value0}} onto {{value1}}',
          { value0: accountLabel, value1: host.label }
        ),
        failureMessage: translate(
          'auto.components.settings.AccountLaneStatusSection.delegateFailed',
          'Could not load {{value0}} onto {{value1}}. The host may have refused the account.',
          { value0: accountLabel, value1: host.label }
        )
      }
    )
  }

  const confirmDelegateAccountLabel = confirmDelegate
    ? (claudeAccounts.find((account) => account.id === confirmDelegate.accountId)?.email ??
      confirmDelegate.accountId)
    : ''
  const confirmDelegateOtherAccounts = confirmDelegate
    ? [...claudeAccounts]
        .filter((account) => account.id !== confirmDelegate.accountId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    : []

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
              busy={busyAccountId === lease.accountId}
              onRename={(friendlyName) =>
                runWrite(lease.accountId, () =>
                  window.api.principalLaneStatus.renameLease(lease.accountId, friendlyName)
                )
              }
              onRelease={() => {
                const accountLabel = lease.friendlyName ?? lease.accountLabel ?? lease.accountId
                void runWrite(
                  lease.accountId,
                  () => window.api.principalLaneStatus.releaseLease(lease.accountId),
                  {
                    successMessage: (result) =>
                      (result as PrincipalLaneStatusReleaseResult).reselectedLocally
                        ? translate(
                            'auto.components.settings.AccountLaneStatusSection.releasedAndReselected',
                            'Released {{value0}}; it is active locally again.',
                            { value0: accountLabel }
                          )
                        : null
                  }
                )
              }}
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
                if (accountId === activeAccountId) {
                  setConfirmDelegate({ host, accountId })
                  return
                }
                doDelegate(host, accountId)
              }}
            />
          ))}
        </div>
      ) : null}

      {confirmDelegate ? (
        <DelegateActiveAccountDialog
          open
          hostLabel={confirmDelegate.host.label}
          accountLabel={confirmDelegateAccountLabel}
          otherAccounts={confirmDelegateOtherAccounts}
          defaultSwitchAccountId={confirmDelegateOtherAccounts[0]?.id ?? null}
          onCancel={() => setConfirmDelegate(null)}
          onDelegateAnyway={() => {
            const { host, accountId } = confirmDelegate
            setConfirmDelegate(null)
            doDelegate(host, accountId)
          }}
          onSwitchThenDelegate={(switchToAccountId) => {
            const { host, accountId } = confirmDelegate
            setConfirmDelegate(null)
            void (async () => {
              setBusyAccountId(host.environmentId)
              try {
                await window.api.claudeAccounts.select({
                  accountId: switchToAccountId,
                  runtime: 'host'
                })
              } finally {
                setBusyAccountId(null)
              }
              doDelegate(host, accountId)
            })()
          }}
        />
      ) : null}
    </section>
  )
}
