// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccountLaneStatusSection } from './AccountLaneStatusSection'
import { resetPrincipalLaneStatusStoreForTest } from './principal-lane-status-store'
import { resetPrincipalLaneStatusSubscriptionForTest } from './principal-lane-status-subscription'
import type { PrincipalLaneStatusSnapshot } from '../../../../shared/principal-lane-status-ipc'

function setWindowApi(
  snapshot: PrincipalLaneStatusSnapshot,
  overrides: Partial<{
    releaseLease: ReturnType<typeof vi.fn>
    renameLease: ReturnType<typeof vi.fn>
  }> = {}
): { releaseLease: ReturnType<typeof vi.fn>; renameLease: ReturnType<typeof vi.fn> } {
  const releaseLease = overrides.releaseLease ?? vi.fn().mockResolvedValue({ released: true })
  const renameLease = overrides.renameLease ?? vi.fn().mockResolvedValue({ renamed: true })
  ;(window as unknown as { api: unknown }).api = {
    principalConsent: { snapshot: vi.fn() },
    principalLaneStatus: {
      get: vi.fn().mockResolvedValue(snapshot),
      onChanged: vi.fn().mockReturnValue(() => {}),
      releaseLease,
      renameLease
    }
  }
  return { releaseLease, renameLease }
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

  it('renders nothing when there are no lanes and no leases', async () => {
    setWindowApi({ lanes: [], delegationLeases: [] })
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
})
