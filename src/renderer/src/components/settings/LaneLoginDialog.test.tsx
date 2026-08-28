// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LaneLoginDialog } from './LaneLoginDialog'

function setApi(overrides: Partial<typeof window.api.laneLogin> = {}): void {
  window.api = {
    laneLogin: {
      get: vi.fn(),
      onChanged: vi.fn(() => () => {}),
      start: vi.fn(async () => ({
        loginSessionId: 's1',
        authorizeUrl: 'https://platform.claude.com/authorize?x=1',
        expiresAt: Date.now() + 60_000
      })),
      submitCode: vi.fn(async () => ({
        status: 'completed',
        identity: { email: 'dev@example.com' },
        attemptsRemaining: 3
      })),
      cancel: vi.fn(async () => ({ cancelled: true })),
      selectAccount: vi.fn(),
      removeAccount: vi.fn(),
      logout: vi.fn(),
      ...overrides
    }
  } as never
}

describe('LaneLoginDialog', () => {
  afterEach(cleanup)

  it('shows the principal/lane/expected-account binding before any login starts (§4 fourth binding)', () => {
    setApi()
    render(
      <LaneLoginDialog
        open
        onOpenChange={vi.fn()}
        environmentId="env-1"
        principalLabel="Ana"
        laneLabel="shared-host"
        onCompleted={vi.fn()}
      />
    )
    const binding = screen.getByTestId('lane-login-binding')
    expect(binding.textContent).toContain('Ana')
    expect(binding.textContent).toContain('shared-host')
  })

  it('disables Start login until the expected email is email-shaped', async () => {
    setApi()
    render(
      <LaneLoginDialog
        open
        onOpenChange={vi.fn()}
        environmentId="env-1"
        principalLabel="Ana"
        laneLabel="shared-host"
        onCompleted={vi.fn()}
      />
    )
    const start = screen.getByTestId('lane-login-start-button')
    expect(start.hasAttribute('disabled')).toBe(true)
    await userEvent.type(screen.getByTestId('lane-login-expected-email-input'), 'not-an-email')
    expect(start.hasAttribute('disabled')).toBe(true)
    await userEvent.type(screen.getByTestId('lane-login-expected-email-input'), '@x.com')
    expect(start.hasAttribute('disabled')).toBe(false)
  })

  it('after loginStart, shows the authorize URL as a link and the code field, never a bare code table', async () => {
    setApi()
    render(
      <LaneLoginDialog
        open
        onOpenChange={vi.fn()}
        environmentId="env-1"
        principalLabel="Ana"
        laneLabel="shared-host"
        onCompleted={vi.fn()}
      />
    )
    await userEvent.type(screen.getByTestId('lane-login-expected-email-input'), 'dev@example.com')
    await userEvent.click(screen.getByTestId('lane-login-start-button'))
    await waitFor(() => expect(screen.getByTestId('lane-login-authorize-url')).toBeTruthy())
    expect(screen.getByTestId('lane-login-authorize-url').getAttribute('href')).toContain(
      'platform.claude.com'
    )
    expect(screen.getByTestId('lane-login-code-input')).toBeTruthy()
  })

  it('renders the host refusal sentence verbatim on a refused loginStart', async () => {
    setApi({
      start: vi.fn(async () => ({
        refused: {
          code: 'accounts.lane.login_not_designated',
          message: 'This device is paired to you but is not the device you designated…'
        }
      }))
    })
    render(
      <LaneLoginDialog
        open
        onOpenChange={vi.fn()}
        environmentId="env-1"
        principalLabel="Ana"
        laneLabel="shared-host"
        onCompleted={vi.fn()}
      />
    )
    await userEvent.type(screen.getByTestId('lane-login-expected-email-input'), 'dev@example.com')
    await userEvent.click(screen.getByTestId('lane-login-start-button'))
    await waitFor(() =>
      expect(screen.getByTestId('lane-login-error').textContent).toContain('designated')
    )
  })

  it('calls onCompleted once the code is accepted', async () => {
    setApi()
    const onCompleted = vi.fn()
    render(
      <LaneLoginDialog
        open
        onOpenChange={vi.fn()}
        environmentId="env-1"
        principalLabel="Ana"
        laneLabel="shared-host"
        onCompleted={onCompleted}
      />
    )
    await userEvent.type(screen.getByTestId('lane-login-expected-email-input'), 'dev@example.com')
    await userEvent.click(screen.getByTestId('lane-login-start-button'))
    await waitFor(() => expect(screen.getByTestId('lane-login-code-input')).toBeTruthy())
    await userEvent.type(screen.getByTestId('lane-login-code-input'), '123456')
    await userEvent.click(screen.getByTestId('lane-login-submit-code-button'))
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1))
  })
})
