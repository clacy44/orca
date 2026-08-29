// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LaneLoginDialog } from './LaneLoginDialog'

const MOCK_QR_DATA_URL = 'data:image/png;base64,mock-qr'

vi.mock('./use-lane-login-qr', () => ({
  useLaneLoginQr: (authorizeUrl: string | null) => (authorizeUrl ? MOCK_QR_DATA_URL : null)
}))

function setApi(
  overrides: Partial<typeof window.api.laneLogin> = {},
  uiOverrides: Partial<typeof window.api.ui> = {}
): void {
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
    },
    ui: {
      writeClipboardText: vi.fn(async () => {}),
      ...uiOverrides
    }
  } as never
}

async function renderAtAwaitingCode(
  props: Partial<React.ComponentProps<typeof LaneLoginDialog>> = {}
): Promise<void> {
  render(
    <LaneLoginDialog
      open
      onOpenChange={vi.fn()}
      environmentId="env-1"
      principalLabel="Ana"
      laneLabel="shared-host"
      onCompleted={vi.fn()}
      {...props}
    />
  )
  await userEvent.type(screen.getByTestId('lane-login-expected-email-input'), 'dev@example.com')
  await userEvent.click(screen.getByTestId('lane-login-start-button'))
  await waitFor(() => expect(screen.getByTestId('lane-login-authorize-url')).toBeTruthy())
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
    await renderAtAwaitingCode()
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
    await renderAtAwaitingCode({ onCompleted })
    await userEvent.type(screen.getByTestId('lane-login-code-input'), '123456')
    await userEvent.click(screen.getByTestId('lane-login-submit-code-button'))
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1))
  })

  // Root cause: DialogContent is a CSS grid, and grid items default to
  // min-width:auto — a nowrap/truncate URL sets the min-content track width
  // for every sibling. Mutation proof: restoring 'truncate' on the anchor (or
  // dropping 'min-w-0' from its wrapping grid item) turns this red.
  it('wraps the authorize URL instead of letting it set the dialog width', async () => {
    setApi()
    await renderAtAwaitingCode()
    const url = screen.getByTestId('lane-login-authorize-url')
    expect(url.className).toContain('break-all')
    expect(url.className).not.toMatch(/\btruncate\b/)
    expect(url.className).not.toMatch(/\bwhitespace-nowrap\b/)

    const gridItem = url.closest('.space-y-3')
    expect(gridItem).not.toBeNull()
    expect(gridItem?.className).toContain('min-w-0')

    const row = url.closest('.space-y-1\\.5')
    expect(row?.className).toContain('min-w-0')
  })

  it('renders the QR code without a full-width white strip', async () => {
    setApi()
    await renderAtAwaitingCode()
    const qr = await screen.findByAltText('QR code for the login link')
    expect(qr.getAttribute('src')).toBe(MOCK_QR_DATA_URL)
    const qrBox = qr.parentElement
    expect(qrBox?.className).not.toMatch(/\bw-full\b/)
    expect(qrBox?.className).not.toMatch(/\bflex-1\b/)
  })

  it('shows Submit code and Cancel in the awaiting-code stage', async () => {
    setApi()
    await renderAtAwaitingCode()
    expect(screen.getByTestId('lane-login-submit-code-button')).toBeTruthy()
    expect(screen.getByTestId('lane-login-cancel-button')).toBeTruthy()
  })

  it('submits on Enter in the code field, using the same guard as the button', async () => {
    setApi()
    const onCompleted = vi.fn()
    await renderAtAwaitingCode({ onCompleted })

    // Empty code: Enter must not submit.
    await userEvent.type(screen.getByTestId('lane-login-code-input'), '{Enter}')
    expect(onCompleted).not.toHaveBeenCalled()

    await userEvent.type(screen.getByTestId('lane-login-code-input'), '123456')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1))
  })

  it('copies the authorize URL to the clipboard via the Copy link button', async () => {
    const writeClipboardText = vi.fn(async () => {})
    setApi({}, { writeClipboardText })
    await renderAtAwaitingCode()
    await userEvent.click(screen.getByTestId('lane-login-copy-url-button'))
    await waitFor(() =>
      expect(writeClipboardText).toHaveBeenCalledWith('https://platform.claude.com/authorize?x=1')
    )
  })
})
