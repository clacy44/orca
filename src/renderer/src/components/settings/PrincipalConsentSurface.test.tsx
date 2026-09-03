// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { isHostConsentSurfaceAvailable, PrincipalConsentSurface } from './PrincipalConsentSurface'
import { resetPrincipalConsentStoreForTest } from './principal-consent-store'
import { resetPrincipalLaneStatusStoreForTest } from './principal-lane-status-store'
import { resetPrincipalLaneStatusSubscriptionForTest } from './principal-lane-status-subscription'
import type { PrincipalConsentSnapshot } from '../../../../shared/principal-consent-ipc'
import type { PrincipalLaneStatusSnapshot } from '../../../../shared/principal-lane-status-ipc'
import type { RuntimeAccessGrant } from '../../../../shared/runtime-access-grants'

type ConsentApi = {
  snapshot: ReturnType<typeof vi.fn>
  createPrincipal: ReturnType<typeof vi.fn>
  bind: ReturnType<typeof vi.fn>
  unbind: ReturnType<typeof vi.fn>
  rebind: ReturnType<typeof vi.fn>
  designatePusher: ReturnType<typeof vi.fn>
  provision: ReturnType<typeof vi.fn>
  deprovision: ReturnType<typeof vi.fn>
  onChanged: ReturnType<typeof vi.fn>
}

const GRANTS: RuntimeAccessGrant[] = [
  {
    deviceId: 'dev-ana',
    name: 'Ana laptop',
    createdAt: 1,
    lastSeenAt: 100,
    grantClass: 'minted',
    expiresAt: null
  },
  {
    deviceId: 'dev-new',
    name: 'New tablet',
    createdAt: 2,
    lastSeenAt: null,
    grantClass: 'minted',
    expiresAt: null
  }
]

const SNAPSHOT: PrincipalConsentSnapshot = {
  principals: [
    { principalId: 'p-ana', displayName: 'Ana', delegatedGrantId: 'dev-ana' },
    { principalId: 'p-boris', displayName: 'Boris', delegatedGrantId: null }
  ],
  bindings: [{ deviceId: 'dev-ana', principalId: 'p-ana' }],
  audit: [
    { at: 500, action: 'bind', principalId: 'p-ana', deviceId: 'dev-ana', direction: 'bind' }
  ],
  provisioningPlatformGate: null
}

const LANE_SNAPSHOT: PrincipalLaneStatusSnapshot = {
  lanes: [
    { principalId: 'p-ana', displayName: 'Ana', delegatedGrantId: 'dev-ana', laneState: 'loaded' }
  ],
  remoteHosts: []
}

function makeConsentApi(snapshot = SNAPSHOT): ConsentApi {
  return {
    snapshot: vi.fn().mockResolvedValue(snapshot),
    createPrincipal: vi.fn().mockResolvedValue({ principalId: 'p-new', displayName: 'x' }),
    bind: vi.fn().mockResolvedValue({ bound: true }),
    unbind: vi.fn().mockResolvedValue({ unbound: true }),
    rebind: vi.fn().mockResolvedValue({ bound: true }),
    designatePusher: vi.fn().mockResolvedValue({ designatedGrantId: 'dev-ana' }),
    provision: vi.fn().mockResolvedValue({ provisioned: true, provenanceLabel: 'x' }),
    deprovision: vi.fn().mockResolvedValue({ deprovisioned: true }),
    onChanged: vi.fn().mockReturnValue(() => {})
  }
}

function setWindowApi(
  consent: ConsentApi | undefined,
  lane: PrincipalLaneStatusSnapshot = LANE_SNAPSHOT
): void {
  ;(window as unknown as { api: unknown }).api = {
    principalConsent: consent,
    principalLaneStatus: {
      get: vi.fn().mockResolvedValue(lane),
      onChanged: vi.fn().mockReturnValue(() => {})
    }
  }
}

function setWebClient(value: boolean): void {
  ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = value
}

describe('PrincipalConsentSurface', () => {
  beforeEach(() => {
    resetPrincipalConsentStoreForTest()
    resetPrincipalLaneStatusStoreForTest()
    resetPrincipalLaneStatusSubscriptionForTest()
    setWebClient(false)
  })
  afterEach(() => {
    cleanup()
    setWebClient(false)
    delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    delete (window as unknown as { api?: unknown }).api
  })

  it('renders nothing on a non-host (web client) build', () => {
    setWindowApi(makeConsentApi())
    setWebClient(true)
    const { container } = render(<PrincipalConsentSurface grants={GRANTS} />)
    expect(container.querySelector('[data-testid="principal-consent-surface"]')).toBeNull()
  })

  it('renders nothing when the host consent bridge is absent', () => {
    setWindowApi(undefined)
    const { container } = render(<PrincipalConsentSurface grants={GRANTS} />)
    expect(container.querySelector('[data-testid="principal-consent-surface"]')).toBeNull()
  })

  it('returns false with no window global (DOM-less render, e.g. renderToStaticMarkup)', () => {
    const savedWindow = globalThis.window
    // @ts-expect-error simulating a DOM-less environment
    delete globalThis.window
    try {
      expect(isHostConsentSurfaceAvailable()).toBe(false)
    } finally {
      globalThis.window = savedWindow
    }
  })

  it('renders a row per device with its binding, pusher badge and never-connected state', async () => {
    setWindowApi(makeConsentApi())
    render(<PrincipalConsentSurface grants={GRANTS} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('consent-device-row')).toHaveLength(2)
    })
    const anaRow = screen
      .getAllByTestId('consent-device-row')
      .find((row) => row.getAttribute('data-device-id') === 'dev-ana') as HTMLElement
    expect(within(anaRow).getByText('Belongs to Ana')).toBeTruthy()
    expect(within(anaRow).getByText('Pusher')).toBeTruthy()
    const newRow = screen
      .getAllByTestId('consent-device-row')
      .find((row) => row.getAttribute('data-device-id') === 'dev-new') as HTMLElement
    expect(within(newRow).getByText('Not bound to a person')).toBeTruthy()
    expect(within(newRow).getByText('Never connected')).toBeTruthy()
  })

  it('shows the provisioned lane state joined from the lane-status store', async () => {
    setWindowApi(makeConsentApi())
    render(<PrincipalConsentSurface grants={GRANTS} />)
    await waitFor(() => {
      expect(screen.getByTestId('consent-lane-state')).toBeTruthy()
    })
    expect(screen.getByTestId('consent-lane-state').textContent).toContain('loaded')
  })

  it('binds an unbound device to a chosen person', async () => {
    const api = makeConsentApi()
    setWindowApi(api)
    render(<PrincipalConsentSurface grants={GRANTS} />)
    await waitFor(() => expect(screen.getAllByTestId('consent-device-row')).toHaveLength(2))
    const newRow = screen
      .getAllByTestId('consent-device-row')
      .find((row) => row.getAttribute('data-device-id') === 'dev-new') as HTMLElement
    const trigger = within(newRow).getByLabelText('Bind New tablet to a person')
    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole('option', { name: 'Boris' }))
    expect(api.bind).toHaveBeenCalledWith('dev-new', 'p-boris')
  })

  it('designates the bound device as its person’s pusher', async () => {
    const api = makeConsentApi({
      ...SNAPSHOT,
      principals: [{ principalId: 'p-ana', displayName: 'Ana', delegatedGrantId: null }]
    })
    setWindowApi(api, { lanes: [], remoteHosts: [] })
    render(<PrincipalConsentSurface grants={GRANTS} />)
    const anaRow = await waitFor(() => {
      const row = screen
        .getAllByTestId('consent-device-row')
        .find((r) => r.getAttribute('data-device-id') === 'dev-ana')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    await userEvent.click(within(anaRow).getByRole('button', { name: 'Set as pusher' }))
    expect(api.designatePusher).toHaveBeenCalledWith('p-ana', 'dev-ana')
  })

  it('provisions the bound person’s lane when none is provisioned', async () => {
    const api = makeConsentApi()
    setWindowApi(api, { lanes: [], remoteHosts: [] })
    render(<PrincipalConsentSurface grants={GRANTS} />)
    const anaRow = await waitFor(() => {
      const row = screen
        .getAllByTestId('consent-device-row')
        .find((r) => r.getAttribute('data-device-id') === 'dev-ana')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    await userEvent.click(within(anaRow).getByRole('button', { name: 'Provision lane' }))
    expect(api.provision).toHaveBeenCalledWith('p-ana', undefined)
  })

  it('deprovisions when the lane is already provisioned', async () => {
    const api = makeConsentApi()
    setWindowApi(api)
    render(<PrincipalConsentSurface grants={GRANTS} />)
    const anaRow = await waitFor(() => {
      const row = screen
        .getAllByTestId('consent-device-row')
        .find((r) => r.getAttribute('data-device-id') === 'dev-ana')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    await userEvent.click(within(anaRow).getByRole('button', { name: 'Deprovision lane' }))
    expect(api.deprovision).toHaveBeenCalledWith('p-ana')
  })

  it('unbinds a bound device', async () => {
    const api = makeConsentApi()
    setWindowApi(api)
    render(<PrincipalConsentSurface grants={GRANTS} />)
    const anaRow = await waitFor(() => {
      const row = screen
        .getAllByTestId('consent-device-row')
        .find((r) => r.getAttribute('data-device-id') === 'dev-ana')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    await userEvent.click(within(anaRow).getByRole('button', { name: 'Unbind' }))
    expect(api.unbind).toHaveBeenCalledWith('dev-ana')
  })

  it('creates a person from the inline field', async () => {
    const api = makeConsentApi()
    setWindowApi(api)
    render(<PrincipalConsentSurface grants={GRANTS} />)
    await waitFor(() => expect(screen.getAllByTestId('consent-device-row')).toHaveLength(2))
    await userEvent.type(screen.getByLabelText('New person name'), 'Carol')
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }))
    expect(api.createPrincipal).toHaveBeenCalledWith('Carol')
  })

  it('renders the audit trail newest-first', async () => {
    setWindowApi(
      makeConsentApi({
        ...SNAPSHOT,
        audit: [
          { at: 100, action: 'create-principal', principalId: 'p-ana' },
          { at: 500, action: 'bind', principalId: 'p-ana', deviceId: 'dev-ana', direction: 'bind' }
        ]
      })
    )
    render(<PrincipalConsentSurface grants={GRANTS} />)
    await waitFor(() => expect(screen.getByTestId('consent-audit-list')).toBeTruthy())
    const rows = screen.getAllByTestId('consent-audit-row')
    expect(rows[0].textContent).toContain('Bound Ana laptop to Ana')
    expect(rows[1].textContent).toContain('Added Ana')
  })
})
