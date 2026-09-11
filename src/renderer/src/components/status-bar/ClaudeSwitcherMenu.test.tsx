// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { ClaudeSwitcherMenu } from './StatusBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type MockRateLimits = {
  claudeTarget: { runtime: 'host' | 'wsl'; wslDistro: string | null }
  inactiveClaudeAccounts: {
    accountId: string
    rateLimits: ProviderRateLimits | null
    updatedAt: number
    isFetching: boolean
  }[]
}

// Why vi.hoisted: vi.mock factories below are hoisted above these declarations, so
// anything a factory reads (not just closes over for later) must live in the hoisted bag.
const mocks = vi.hoisted(() => ({
  fetchProviderAccountsSnapshot: vi.fn(),
  fetchInactiveClaudeAccountUsage: vi.fn(async () => {}),
  recordFeatureInteraction: vi.fn(),
  refreshClaudeRateLimitsForTarget: vi.fn(async () => {}),
  openSettingsPage: vi.fn(),
  fetchSettings: vi.fn(async () => {}),
  settings: null as GlobalSettings | null,
  rateLimits: null as MockRateLimits | null,
  runtimeEnvironments: [] as { id: string; name: string }[]
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) => {
    if (!options) {
      return fallback
    }
    return Object.entries(options).reduce(
      (acc, [key, value]) => acc.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
  }
}))

vi.mock('@/lib/windows-terminal-capabilities', () => ({
  useWindowsTerminalCapabilities: () => ({
    wslAvailable: false,
    wslDistros: [],
    pwshAvailable: false,
    gitBashAvailable: false,
    hostPlatform: null,
    isLoading: false
  }),
  getWindowsTerminalCapabilityOwnerKey: () => 'test-owner-key'
}))

vi.mock('@/hooks/useResetCountdownClock', () => ({
  useResetCountdownClock: () => 1_000_000_000
}))

vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot: (...args: unknown[]) =>
    mocks.fetchProviderAccountsSnapshot(...args),
  selectClaudeProviderAccount: vi.fn(),
  selectCodexProviderAccount: vi.fn()
}))

vi.mock('@/components/ui/dropdown-menu', async () => {
  const ReactModule = await import('react')
  type ItemProps = {
    children: ReactNode
    onSelect?: (event: { preventDefault: () => void }) => void
    disabled?: boolean
  }
  return {
    DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuCheckboxItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuItem: ({ children, onSelect, disabled }: ItemProps) => (
      <button
        type="button"
        disabled={disabled}
        onClick={() => onSelect?.({ preventDefault: () => {} })}
      >
        {children}
      </button>
    ),
    DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuSub: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => (
      <ReactModule.Fragment>{children}</ReactModule.Fragment>
    )
  }
})

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      openSettingsPage: mocks.openSettingsPage,
      openSettingsTarget: null,
      fetchSettings: mocks.fetchSettings,
      recordFeatureInteraction: mocks.recordFeatureInteraction,
      refreshClaudeRateLimitsForTarget: mocks.refreshClaudeRateLimitsForTarget,
      fetchInactiveClaudeAccountUsage: mocks.fetchInactiveClaudeAccountUsage,
      rateLimits: mocks.rateLimits,
      settings: mocks.settings,
      runtimeEnvironments: mocks.runtimeEnvironments,
      usagePercentageDisplay: 'used'
    })
}))

const claudeProvider: ProviderRateLimits = {
  provider: 'claude',
  session: null,
  weekly: null,
  updatedAt: 0,
  error: null,
  status: 'ok'
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderMenu(claude: ProviderRateLimits = claudeProvider): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<ClaudeSwitcherMenu claude={claude} compact={false} iconOnly={false} />)
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  mocks.settings = {
    activeRuntimeEnvironmentId: 'env-1',
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} },
    claudeManagedAccounts: []
  } as unknown as GlobalSettings
  mocks.rateLimits = {
    claudeTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: []
  }
  mocks.runtimeEnvironments = [{ id: 'env-1', name: 'Remote VPS' }]
  mocks.fetchInactiveClaudeAccountUsage.mockClear()
  mocks.recordFeatureInteraction.mockClear()
  mocks.fetchProviderAccountsSnapshot.mockReset()
  mocks.fetchProviderAccountsSnapshot.mockResolvedValue({
    claude: {
      accounts: [
        {
          id: 'inactive-1',
          email: 'inactive-1@example.com',
          managedAuthRuntime: 'host',
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    codex: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    rateLimits: null
  })
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  if (container) {
    container.remove()
  }
  container = null
})

function findToggle(): HTMLButtonElement {
  const buttons = Array.from(container?.querySelectorAll('button') ?? [])
  const toggle = buttons.find((button) => button.textContent?.includes('System default'))
  if (!toggle) {
    throw new Error('accounts toggle not found')
  }
  return toggle
}

describe('ClaudeSwitcherMenu inactive-account usage (R114)', () => {
  it('fetches inactive-account usage on expansion even while a remote runtime environment is active', async () => {
    renderMenu()
    await flush()

    expect(mocks.settings?.activeRuntimeEnvironmentId).toBe('env-1')
    act(() => {
      findToggle().click()
    })

    expect(mocks.fetchInactiveClaudeAccountUsage).toHaveBeenCalledTimes(1)
  })

  it('renders a last-known value with its age instead of blanking a stale cached usage row', async () => {
    const now = Date.now()
    mocks.rateLimits = {
      claudeTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [
        {
          accountId: 'inactive-1',
          rateLimits: {
            provider: 'claude',
            session: {
              usedPercent: 76,
              windowMinutes: 300,
              resetsAt: null,
              resetDescription: null
            },
            weekly: null,
            updatedAt: now - 45 * 60 * 1000,
            error: null,
            status: 'ok'
          },
          updatedAt: now - 45 * 60 * 1000,
          isFetching: false
        }
      ]
    }

    renderMenu()
    await flush()
    act(() => {
      findToggle().click()
    })

    const text = container?.textContent ?? ''
    expect(text).toContain('min ago')
  })
})

describe('ClaudeSwitcherMenu per-account usage rows (R146)', () => {
  it('R1 renders usage bars for the active account row (D1)', async () => {
    if (mocks.settings) {
      mocks.settings.activeRuntimeEnvironmentId = ''
    }
    const activeClaude: ProviderRateLimits = {
      provider: 'claude',
      session: { usedPercent: 42, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }

    renderMenu(activeClaude)
    await flush()
    act(() => {
      findToggle().click()
    })
    await flush()

    // Why: the top ProviderPanel also renders the live `claude` snapshot, so a
    // plain container-text search for "42% used" would false-pass even
    // without D1's fix. Scope to the expanded account row itself — the only
    // button carrying the "Active" badge — instead.
    const buttons = Array.from(container?.querySelectorAll('button') ?? [])
    const activeRow = buttons.find((button) => button.textContent?.includes('Active'))
    if (!activeRow) {
      throw new Error('active account row not found')
    }
    expect(activeRow.textContent ?? '').toContain('42% used')
  })

  it('R2 shows "No usage yet" for a target with no cached usage (D4)', async () => {
    if (mocks.settings) {
      mocks.settings.activeRuntimeEnvironmentId = ''
      // Why: locally, resolveClaudeStatusAccountState reads the switch-target
      // roster from settings.claudeManagedAccounts, not the fetched snapshot.
      mocks.settings.claudeManagedAccounts = [
        {
          id: 'inactive-1',
          email: 'inactive-1@example.com',
          managedAuthPath: '/tmp/inactive-1/auth',
          authMethod: 'subscription-oauth',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    }
    mocks.rateLimits = {
      claudeTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: []
    }

    renderMenu()
    await flush()
    act(() => {
      findToggle().click()
    })
    await flush()

    const text = container?.textContent ?? ''
    expect(text).toContain('No usage yet')
  })

  it('R3 shows a live 2-minute age caption for a fresh cached entry (D5)', async () => {
    if (mocks.settings) {
      mocks.settings.activeRuntimeEnvironmentId = ''
      mocks.settings.claudeManagedAccounts = [
        {
          id: 'inactive-1',
          email: 'inactive-1@example.com',
          managedAuthPath: '/tmp/inactive-1/auth',
          authMethod: 'subscription-oauth',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    }
    const now = Date.now()
    mocks.rateLimits = {
      claudeTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [
        {
          accountId: 'inactive-1',
          rateLimits: {
            provider: 'claude',
            session: {
              usedPercent: 10,
              windowMinutes: 300,
              resetsAt: null,
              resetDescription: null
            },
            weekly: null,
            updatedAt: now - 2 * 60 * 1000,
            error: null,
            status: 'ok'
          },
          updatedAt: now - 2 * 60 * 1000,
          isFetching: false
        }
      ]
    }

    renderMenu()
    await flush()
    act(() => {
      findToggle().click()
    })
    await flush()

    const text = container?.textContent ?? ''
    expect(text).toContain('2 min ago')
  })

  it('R4 renders the remote-paired snapshot rateLimits row, not the local cache (D2)', async () => {
    // mocks.settings.activeRuntimeEnvironmentId stays 'env-1' from beforeEach.
    const now = Date.now()
    mocks.fetchProviderAccountsSnapshot.mockReset()
    mocks.fetchProviderAccountsSnapshot.mockResolvedValue({
      claude: {
        accounts: [
          {
            id: 'inactive-1',
            email: 'inactive-1@example.com',
            managedAuthRuntime: 'host',
            authMethod: 'subscription-oauth',
            organizationUuid: null,
            organizationName: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} }
      },
      codex: {
        accounts: [],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} }
      },
      rateLimits: {
        claude: null,
        codex: null,
        gemini: null,
        opencodeGo: null,
        kimi: null,
        antigravity: null,
        minimax: null,
        grok: null,
        minimaxCookieConfigured: false,
        grokAuthConfigured: false,
        claudeTarget: { runtime: 'host', wslDistro: null },
        codexTarget: { runtime: 'host', wslDistro: null },
        inactiveClaudeAccounts: [
          {
            accountId: 'inactive-1',
            rateLimits: {
              provider: 'claude',
              session: {
                usedPercent: 55,
                windowMinutes: 300,
                resetsAt: null,
                resetDescription: null
              },
              weekly: null,
              updatedAt: now,
              error: null,
              status: 'ok'
            },
            updatedAt: now,
            isFetching: false
          }
        ],
        inactiveCodexAccounts: []
      }
    })
    // Why: the LOCAL store's cache is deliberately empty/stale — the fix must
    // read the remote-paired snapshot's rateLimits instead of this.
    mocks.rateLimits = {
      claudeTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: []
    }

    renderMenu()
    await flush()
    act(() => {
      findToggle().click()
    })
    await flush()

    const text = container?.textContent ?? ''
    expect(text).toContain('55% used')
  })
})
