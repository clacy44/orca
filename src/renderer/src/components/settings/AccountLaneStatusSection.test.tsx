// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  }> = {}
): {
  releaseLease: ReturnType<typeof vi.fn>
  renameLease: ReturnType<typeof vi.fn>
  delegateAccountToHost: ReturnType<typeof vi.fn>
} {
  const releaseLease = overrides.releaseLease ?? vi.fn().mockResolvedValue({ released: true })
  const renameLease = overrides.renameLease ?? vi.fn().mockResolvedValue({ renamed: true })
  const delegateAccountToHost =
    overrides.delegateAccountToHost ?? vi.fn().mockResolvedValue({ delegated: true })
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
    claudeAccounts: { list: claudeAccountsList }
  }
  return { releaseLease, renameLease, delegateAccountToHost }
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
      expiresAt: null
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

  it('shows the lease with host, person and since, and releases it', async () => {
    const { releaseLease } = setWindowApi(LANES_SNAPSHOT)
    render(<AccountLaneStatusSection />)
    const leaseRow = await waitFor(() => {
      const row = screen.queryByTestId('account-lane-lease-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    expect(within(leaseRow).getByText(/On host-x for Ana/)).toBeTruthy()
    await userEvent.click(within(leaseRow).getByRole('button', { name: 'Release' }))
    expect(releaseLease).toHaveBeenCalledWith('acct-1')
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
})
