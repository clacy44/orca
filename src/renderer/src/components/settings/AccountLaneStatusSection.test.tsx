// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { success: toastSuccessMock, error: toastErrorMock } }))

import { AccountLaneStatusSection } from './AccountLaneStatusSection'
import { resetPrincipalLaneStatusStoreForTest } from './principal-lane-status-store'
import { resetPrincipalLaneStatusSubscriptionForTest } from './principal-lane-status-subscription'
import type { PrincipalLaneStatusSnapshot } from '../../../../shared/principal-lane-status-ipc'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'

// Real radix Select needs pointer-capture APIs happy-dom does not implement; a plain-button stand-in
// keeps this file's tests about the delegate action, not about radix's popover internals.
vi.mock('../ui/select', async () => {
  const React = await import('react')
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({})
  return {
    Select: ({
      value,
      onValueChange,
      children
    }: {
      value?: string
      onValueChange: (value: string) => void
      children: React.ReactNode
    }) => {
      const contextValue = React.useMemo(() => ({ onValueChange }), [onValueChange])
      return (
        <SelectContext.Provider value={contextValue}>
          <div data-slot="select" data-value={value}>
            {children}
          </div>
        </SelectContext.Provider>
      )
    },
    SelectTrigger: ({ children, ...props }: React.ComponentProps<'button'>) => (
      <button type="button" data-slot="select-trigger" {...props}>
        {children}
      </button>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div data-slot="select-content">{children}</div>
    ),
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const { onValueChange } = React.useContext(SelectContext)
      return (
        <button
          type="button"
          data-slot="select-item"
          data-value={value}
          onClick={() => onValueChange?.(value)}
        >
          {children}
        </button>
      )
    }
  }
})

function setWindowApi(
  snapshot: PrincipalLaneStatusSnapshot,
  overrides: Partial<{
    releaseLease: ReturnType<typeof vi.fn>
    renameLease: ReturnType<typeof vi.fn>
    delegateAccountToHost: ReturnType<typeof vi.fn>
    claudeAccountsList: ReturnType<typeof vi.fn>
    claudeAccountsSelect: ReturnType<typeof vi.fn>
  }> = {}
): {
  releaseLease: ReturnType<typeof vi.fn>
  renameLease: ReturnType<typeof vi.fn>
  delegateAccountToHost: ReturnType<typeof vi.fn>
  claudeAccountsSelect: ReturnType<typeof vi.fn>
} {
  const releaseLease =
    overrides.releaseLease ??
    vi.fn().mockResolvedValue({ released: true, reselectedLocally: false })
  const renameLease = overrides.renameLease ?? vi.fn().mockResolvedValue({ renamed: true })
  const delegateAccountToHost =
    overrides.delegateAccountToHost ?? vi.fn().mockResolvedValue({ delegated: true })
  const claudeAccountsSelect = overrides.claudeAccountsSelect ?? vi.fn().mockResolvedValue({})
  const claudeAccountsList =
    overrides.claudeAccountsList ??
    vi.fn().mockResolvedValue({
      accounts: [
        {
          id: 'acct-work',
          email: 'ana@corp.test',
          authMethod: 'subscription-oauth',
          createdAt: 0,
          updatedAt: 0,
          lastAuthenticatedAt: 0
        }
      ],
      activeAccountId: null
    } satisfies ClaudeRateLimitAccountsState)
  ;(window as unknown as { api: unknown }).api = {
    principalConsent: { snapshot: vi.fn() },
    principalLaneStatus: {
      get: vi.fn().mockResolvedValue(snapshot),
      onChanged: vi.fn().mockReturnValue(() => {}),
      releaseLease,
      renameLease,
      delegateAccountToHost
    },
    claudeAccounts: { list: claudeAccountsList, select: claudeAccountsSelect }
  }
  return { releaseLease, renameLease, delegateAccountToHost, claudeAccountsSelect }
}

function setWebClient(value: boolean): void {
  ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = value
}

const LANES_SNAPSHOT: PrincipalLaneStatusSnapshot = {
  lanes: [
    { principalId: 'p-ana', displayName: 'Ana', delegatedGrantId: 'dev-ana', laneState: 'loaded' },
    {
      principalId: 'p-boris',
      displayName: 'Boris',
      delegatedGrantId: 'dev-boris',
      laneState: 'absent'
    }
  ],
  delegationLeases: [
    {
      accountId: 'acct-1',
      accountUuid: null,
      hostId: 'host-x',
      principalId: 'p-ana',
      delegatedGrantId: 'dev-ana',
      since: 1_700_000_000_000,
      expiresAt: null,
      accountLabel: 'ana@corp.test',
      hostLabel: 'Office Mac',
      personLabel: 'Ana'
    }
  ],
  delegableHosts: []
}

// No name resolved on any of the three additive fields — the card must fall back to the raw ids.
const LEASE_WITH_UNRESOLVED_NAMES_SNAPSHOT: PrincipalLaneStatusSnapshot = {
  lanes: [],
  delegationLeases: [
    {
      accountId: 'acct-unresolved',
      accountUuid: null,
      hostId: 'host-unresolved',
      principalId: 'p-unresolved',
      delegatedGrantId: 'dev-unresolved',
      since: 1_700_000_000_000,
      expiresAt: null,
      accountLabel: null,
      hostLabel: null,
      personLabel: null
    }
  ],
  delegableHosts: []
}

const DELEGABLE_HOSTS_SNAPSHOT: PrincipalLaneStatusSnapshot = {
  lanes: [],
  delegationLeases: [],
  delegableHosts: [
    { environmentId: 'env-1', label: 'Office Mac', laneId: 'p-ana', laneState: 'absent' }
  ]
}

describe('AccountLaneStatusSection', () => {
  beforeEach(() => {
    resetPrincipalLaneStatusStoreForTest()
    resetPrincipalLaneStatusSubscriptionForTest()
    setWebClient(false)
    toastSuccessMock.mockClear()
    toastErrorMock.mockClear()
  })
  afterEach(() => {
    cleanup()
    delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    delete (window as unknown as { api?: unknown }).api
  })

  it('renders nothing on a non-host (web client) build', () => {
    setWindowApi(LANES_SNAPSHOT)
    setWebClient(true)
    const { container } = render(<AccountLaneStatusSection />)
    expect(container.querySelector('[data-testid="account-lane-status-section"]')).toBeNull()
  })

  it('renders nothing when there are no lanes, leases or delegable hosts', async () => {
    setWindowApi({ lanes: [], delegationLeases: [], delegableHosts: [] })
    const { container } = render(<AccountLaneStatusSection />)
    await waitFor(() => expect(window.api.principalLaneStatus.get).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="account-lane-status-section"]')).toBeNull()
  })

  it('shows each lane with its residency badge and the operating rule', async () => {
    setWindowApi(LANES_SNAPSHOT)
    render(<AccountLaneStatusSection />)
    await waitFor(() => expect(screen.getAllByTestId('account-lane-row')).toHaveLength(2))
    expect(screen.getByTestId('lane-operating-rule').textContent).toContain(
      'One pusher, one puller'
    )
    const anaLane = screen
      .getAllByTestId('account-lane-row')
      .find((row) => row.getAttribute('data-principal-id') === 'p-ana') as HTMLElement
    expect(within(anaLane).getByText('Loaded')).toBeTruthy()
  })

  it('names the "no push received" state for an absent designated lane', async () => {
    setWindowApi(LANES_SNAPSHOT)
    render(<AccountLaneStatusSection />)
    const borisLane = await waitFor(() => {
      const row = screen
        .getAllByTestId('account-lane-row')
        .find((r) => r.getAttribute('data-principal-id') === 'p-boris')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    expect(within(borisLane).getByTestId('lane-no-push').textContent).toContain(
      'No push received from dev-boris'
    )
  })

  it('shows the lease with the account, host and person names, and releases it', async () => {
    const { releaseLease } = setWindowApi(LANES_SNAPSHOT)
    render(<AccountLaneStatusSection />)
    const leaseRow = await waitFor(() => {
      const row = screen.queryByTestId('account-lane-lease-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    expect(within(leaseRow).getByText('ana@corp.test')).toBeTruthy()
    expect(within(leaseRow).getByText(/Office Mac \(Ana\)/)).toBeTruthy()
    await userEvent.click(within(leaseRow).getByRole('button', { name: 'Release' }))
    expect(releaseLease).toHaveBeenCalledWith('acct-1')
  })

  it('falls back to the raw ids when the lease has no resolved names', async () => {
    setWindowApi(LEASE_WITH_UNRESOLVED_NAMES_SNAPSHOT)
    render(<AccountLaneStatusSection />)
    const leaseRow = await waitFor(() => {
      const row = screen.queryByTestId('account-lane-lease-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    expect(within(leaseRow).getByText('acct-unresolved')).toBeTruthy()
    expect(within(leaseRow).getByText(/host-unresolved \(p-unresolved\)/)).toBeTruthy()
  })

  it('edits and persists the Q3 friendly name', async () => {
    const { renameLease } = setWindowApi(LANES_SNAPSHOT)
    render(<AccountLaneStatusSection />)
    const leaseRow = await waitFor(() => {
      const row = screen.queryByTestId('account-lane-lease-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    await userEvent.click(within(leaseRow).getByRole('button', { name: 'Rename account' }))
    const input = within(leaseRow).getByLabelText('Friendly name for this account')
    await userEvent.type(input, 'work')
    await userEvent.click(within(leaseRow).getByRole('button', { name: 'Save name' }))
    expect(renameLease).toHaveBeenCalledWith('acct-1', 'work')
  })

  it('lists a delegable host with an account picker and delegates the chosen account', async () => {
    const { delegateAccountToHost } = setWindowApi(DELEGABLE_HOSTS_SNAPSHOT)
    render(<AccountLaneStatusSection />)
    const hostRow = await waitFor(() => {
      const row = screen.queryByTestId('delegate-host-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    expect(within(hostRow).getByText('Office Mac')).toBeTruthy()
    await waitFor(() => expect(window.api.claudeAccounts.list).toHaveBeenCalled())

    const delegateButton = within(hostRow).getByTestId('delegate-host-button')
    expect(delegateButton).toBeDisabled()

    await userEvent.click(await within(hostRow).findByText('ana@corp.test'))
    expect(delegateButton).not.toBeDisabled()

    await userEvent.click(delegateButton)
    expect(delegateAccountToHost).toHaveBeenCalledWith('acct-work', 'env-1')
  })

  it('toasts success with the account and host names when the delegate call resolves delegated:true', async () => {
    setWindowApi(DELEGABLE_HOSTS_SNAPSHOT)
    render(<AccountLaneStatusSection />)
    const hostRow = await waitFor(() => {
      const row = screen.queryByTestId('delegate-host-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    await waitFor(() => expect(window.api.claudeAccounts.list).toHaveBeenCalled())
    await userEvent.click(await within(hostRow).findByText('ana@corp.test'))
    await userEvent.click(within(hostRow).getByTestId('delegate-host-button'))
    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith('Loaded ana@corp.test onto Office Mac')
    )
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('toasts the refusal sentence when the delegate call resolves delegated:false', async () => {
    setWindowApi(DELEGABLE_HOSTS_SNAPSHOT, {
      delegateAccountToHost: vi.fn().mockResolvedValue({ delegated: false })
    })
    render(<AccountLaneStatusSection />)
    const hostRow = await waitFor(() => {
      const row = screen.queryByTestId('delegate-host-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    await waitFor(() => expect(window.api.claudeAccounts.list).toHaveBeenCalled())
    await userEvent.click(await within(hostRow).findByText('ana@corp.test'))
    await userEvent.click(within(hostRow).getByTestId('delegate-host-button'))
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
    expect(toastErrorMock.mock.calls[0][1]?.description).toContain(
      'Could not load ana@corp.test onto Office Mac'
    )
    expect(toastSuccessMock).not.toHaveBeenCalled()
  })

  it('disables the Delegate button while the delegate call is in flight', async () => {
    let resolveDelegate: (result: { delegated: boolean }) => void = () => {}
    const delegateAccountToHost = vi.fn(
      () =>
        new Promise<{ delegated: boolean }>((resolve) => {
          resolveDelegate = resolve
        })
    )
    setWindowApi(DELEGABLE_HOSTS_SNAPSHOT, { delegateAccountToHost })
    render(<AccountLaneStatusSection />)
    const hostRow = await waitFor(() => {
      const row = screen.queryByTestId('delegate-host-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    await waitFor(() => expect(window.api.claudeAccounts.list).toHaveBeenCalled())
    await userEvent.click(await within(hostRow).findByText('ana@corp.test'))
    const delegateButton = within(hostRow).getByTestId('delegate-host-button')
    await userEvent.click(delegateButton)
    await waitFor(() => expect(delegateButton).toBeDisabled())
    resolveDelegate({ delegated: true })
    await waitFor(() => expect(delegateButton).not.toBeDisabled())
  })

  it('shows the "signed out of local terminals" note on a lease taken from the local selection', async () => {
    setWindowApi({
      lanes: [],
      delegationLeases: [
        {
          accountId: 'acct-1',
          accountUuid: null,
          hostId: 'host-x',
          principalId: 'p-ana',
          delegatedGrantId: 'dev-ana',
          since: 1_700_000_000_000,
          expiresAt: null,
          accountLabel: 'ana@corp.test',
          hostLabel: 'Office Mac',
          personLabel: 'Ana',
          wasLocalActive: true
        }
      ],
      delegableHosts: []
    })
    render(<AccountLaneStatusSection />)
    const leaseRow = await waitFor(() => {
      const row = screen.queryByTestId('account-lane-lease-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    expect(within(leaseRow).getByTestId('lease-signed-out-locally').textContent).toContain(
      'Signed out of local terminals while loaded on Office Mac'
    )
  })

  it('toasts that the account is active locally again when release re-selects it', async () => {
    const { releaseLease } = setWindowApi(
      {
        lanes: [],
        delegationLeases: [
          {
            accountId: 'acct-1',
            accountUuid: null,
            hostId: 'host-x',
            principalId: 'p-ana',
            delegatedGrantId: 'dev-ana',
            since: 1_700_000_000_000,
            expiresAt: null,
            accountLabel: 'ana@corp.test',
            hostLabel: 'Office Mac',
            personLabel: 'Ana',
            wasLocalActive: true
          }
        ],
        delegableHosts: []
      },
      { releaseLease: vi.fn().mockResolvedValue({ released: true, reselectedLocally: true }) }
    )
    render(<AccountLaneStatusSection />)
    const leaseRow = await waitFor(() => {
      const row = screen.queryByTestId('account-lane-lease-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    await userEvent.click(within(leaseRow).getByRole('button', { name: 'Release' }))
    expect(releaseLease).toHaveBeenCalledWith('acct-1')
    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith(
        'Released ana@corp.test; it is active locally again.'
      )
    )
  })

  describe('delegating the desktop’s own active account', () => {
    const ACCOUNTS_WITH_ACTIVE = {
      accounts: [
        {
          id: 'acct-work',
          email: 'ana@corp.test',
          authMethod: 'subscription-oauth',
          createdAt: 0,
          updatedAt: 200,
          lastAuthenticatedAt: 0
        },
        {
          id: 'acct-personal',
          email: 'ana.personal@corp.test',
          authMethod: 'subscription-oauth',
          createdAt: 0,
          updatedAt: 100,
          lastAuthenticatedAt: 0
        }
      ],
      activeAccountId: 'acct-work'
    } satisfies ClaudeRateLimitAccountsState

    async function openConfirmDialog(overrides: Parameters<typeof setWindowApi>[1] = {}): Promise<{
      hostRow: HTMLElement
      dialog: HTMLElement
      delegateAccountToHost: ReturnType<typeof vi.fn>
      claudeAccountsSelect: ReturnType<typeof vi.fn>
    }> {
      const { delegateAccountToHost, claudeAccountsSelect } = setWindowApi(
        DELEGABLE_HOSTS_SNAPSHOT,
        {
          claudeAccountsList: vi.fn().mockResolvedValue(ACCOUNTS_WITH_ACTIVE),
          ...overrides
        }
      )
      render(<AccountLaneStatusSection />)
      const hostRow = await waitFor(() => {
        const row = screen.queryByTestId('delegate-host-row')
        expect(row).toBeTruthy()
        return row as HTMLElement
      })
      await waitFor(() => expect(window.api.claudeAccounts.list).toHaveBeenCalled())
      await userEvent.click(await within(hostRow).findByText('ana@corp.test'))
      await userEvent.click(within(hostRow).getByTestId('delegate-host-button'))
      const dialog = await waitFor(() => {
        const el = screen.queryByTestId('delegate-active-account-dialog')
        expect(el).toBeTruthy()
        return el as HTMLElement
      })
      return { hostRow, dialog, delegateAccountToHost, claudeAccountsSelect }
    }

    it('asks for confirmation instead of delegating immediately', async () => {
      const { delegateAccountToHost } = await openConfirmDialog()
      expect(delegateAccountToHost).not.toHaveBeenCalled()
    })

    it('does not delegate when the picker never selects an active local account', async () => {
      const { delegateAccountToHost } = setWindowApi(DELEGABLE_HOSTS_SNAPSHOT, {
        claudeAccountsList: vi.fn().mockResolvedValue({
          ...ACCOUNTS_WITH_ACTIVE,
          activeAccountId: 'acct-other'
        })
      })
      render(<AccountLaneStatusSection />)
      const hostRow = await waitFor(() => {
        const row = screen.queryByTestId('delegate-host-row')
        expect(row).toBeTruthy()
        return row as HTMLElement
      })
      await waitFor(() => expect(window.api.claudeAccounts.list).toHaveBeenCalled())
      await userEvent.click(await within(hostRow).findByText('ana@corp.test'))
      await userEvent.click(within(hostRow).getByTestId('delegate-host-button'))
      expect(screen.queryByTestId('delegate-active-account-dialog')).toBeNull()
      await waitFor(() => expect(delegateAccountToHost).toHaveBeenCalledWith('acct-work', 'env-1'))
    })

    it('cancels without delegating', async () => {
      const { dialog, delegateAccountToHost } = await openConfirmDialog()
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByTestId('delegate-active-account-dialog')).toBeNull()
      expect(delegateAccountToHost).not.toHaveBeenCalled()
    })

    it('delegates anyway on request, without switching local use first', async () => {
      const { dialog, delegateAccountToHost, claudeAccountsSelect } = await openConfirmDialog()
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delegate anyway' }))
      await waitFor(() => expect(delegateAccountToHost).toHaveBeenCalledWith('acct-work', 'env-1'))
      expect(claudeAccountsSelect).not.toHaveBeenCalled()
    })

    it('switches local use to the most recently used other account, then delegates', async () => {
      const { dialog, delegateAccountToHost, claudeAccountsSelect } = await openConfirmDialog()
      const switchButton = within(dialog).getByRole('button', {
        name: 'Switch local use to ana.personal@corp.test'
      })
      await userEvent.click(switchButton)
      await waitFor(() =>
        expect(claudeAccountsSelect).toHaveBeenCalledWith({
          accountId: 'acct-personal',
          runtime: 'host'
        })
      )
      await waitFor(() => expect(delegateAccountToHost).toHaveBeenCalledWith('acct-work', 'env-1'))
    })
  })
})
