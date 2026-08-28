// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccountLaneStatusSection } from './AccountLaneStatusSection'
import { resetPrincipalLaneStatusStoreForTest } from './principal-lane-status-store'
import { resetPrincipalLaneStatusSubscriptionForTest } from './principal-lane-status-subscription'
import type { PrincipalLaneStatusSnapshot } from '../../../../shared/principal-lane-status-ipc'

// S9-L2's per-host lane-login UI renders alongside `RemoteHostRow`; mocked out here since this
// file is about the residency/discoverability section, not the login quartet.
vi.mock('./LaneLoginSection', () => ({ LaneLoginSection: () => null }))

function setWindowApi(
  snapshot: PrincipalLaneStatusSnapshot,
  overrides: Partial<{ refreshHost: ReturnType<typeof vi.fn> }> = {}
): { refreshHost: ReturnType<typeof vi.fn> } {
  const refreshHost = overrides.refreshHost ?? vi.fn().mockResolvedValue({ refreshed: true })
  ;(window as unknown as { api: unknown }).api = {
    principalConsent: { snapshot: vi.fn() },
    principalLaneStatus: {
      get: vi.fn().mockResolvedValue(snapshot),
      onChanged: vi.fn().mockReturnValue(() => {}),
      refreshHost
    }
  }
  return { refreshHost }
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
  remoteHosts: []
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

  it('renders nothing when there are no lanes or remote hosts at all', async () => {
    setWindowApi({ lanes: [], remoteHosts: [] })
    const { container } = render(<AccountLaneStatusSection />)
    await waitFor(() => expect(window.api.principalLaneStatus.get).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="account-lane-status-section"]')).toBeNull()
  })

  it('renders with a short empty-state sentence when local lanes exist but no remote host is paired', async () => {
    setWindowApi(LANES_SNAPSHOT)
    render(<AccountLaneStatusSection />)
    await waitFor(() => expect(screen.getAllByTestId('account-lane-row')).toHaveLength(2))
    expect(screen.getByTestId('remote-hosts-empty').textContent).toContain(
      'No remote Orca environments'
    )
    expect(screen.queryByTestId('remote-host-row')).toBeNull()
  })

  it('shows each lane with its residency badge and the operating rule', async () => {
    setWindowApi(LANES_SNAPSHOT)
    render(<AccountLaneStatusSection />)
    await waitFor(() => expect(screen.getAllByTestId('account-lane-row')).toHaveLength(2))
    expect(screen.getByTestId('lane-operating-rule').textContent).toContain(
      'independent of any account'
    )
    const anaLane = screen
      .getAllByTestId('account-lane-row')
      .find((row) => row.getAttribute('data-principal-id') === 'p-ana') as HTMLElement
    expect(within(anaLane).getByText('Loaded')).toBeTruthy()
  })

  it('names the designated-but-not-loaded state for an absent designated lane', async () => {
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
      'Lane designated to dev-boris'
    )
  })

  it('shows "checking…" for a remote host with no status yet', async () => {
    setWindowApi({
      lanes: [],
      remoteHosts: [{ environmentId: 'env-1', label: 'VPS', state: 'checking' }]
    })
    render(<AccountLaneStatusSection />)
    const hostRow = await waitFor(() => {
      const row = screen.queryByTestId('remote-host-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    expect(within(hostRow).getByTestId('remote-host-checking').textContent).toContain('Checking')
  })

  it('names the not-designated remedy for a connected, undesignated remote host', async () => {
    setWindowApi({
      lanes: [],
      remoteHosts: [{ environmentId: 'env-1', label: 'VPS', state: 'not-designated' }]
    })
    render(<AccountLaneStatusSection />)
    const hostRow = await waitFor(() => {
      const row = screen.queryByTestId('remote-host-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    const message = within(hostRow).getByTestId('remote-host-not-designated').textContent
    expect(message).toContain('not designated for any person on VPS')
    expect(message).toContain('orca lane designate')
  })

  it('names the upgrade remedy for a remote host that does not support lanes', async () => {
    setWindowApi({
      lanes: [],
      remoteHosts: [{ environmentId: 'env-1', label: 'Old VPS', state: 'unsupported' }]
    })
    render(<AccountLaneStatusSection />)
    const hostRow = await waitFor(() => {
      const row = screen.queryByTestId('remote-host-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    expect(within(hostRow).getByTestId('remote-host-unsupported').textContent).toContain(
      'not supported'
    )
  })

  it('the Refresh button on a remote host row invokes the refresh IPC', async () => {
    const { refreshHost } = setWindowApi({
      lanes: [],
      remoteHosts: [{ environmentId: 'env-1', label: 'VPS', state: 'not-designated' }]
    })
    render(<AccountLaneStatusSection />)
    const hostRow = await waitFor(() => {
      const row = screen.queryByTestId('remote-host-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    await userEvent.click(within(hostRow).getByTestId('refresh-host-button'))
    expect(refreshHost).toHaveBeenCalledWith('env-1')
  })
})
