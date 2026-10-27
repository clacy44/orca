// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

const mocks = vi.hoisted(() => ({
  now: 1_000_000_000,
  useResetCountdownClock: vi.fn(() => 1_000_000_000)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-icon={agent} />
}))
vi.mock('@/hooks/useResetCountdownClock', () => ({
  useResetCountdownClock: mocks.useResetCountdownClock
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    onSelect: _onSelect,
    ...props
  }: React.PropsWithChildren<{ onSelect?: () => void }>) => <div {...props}>{children}</div>
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import {
  ClaudeAccountUsageList,
  getTightestUsageSection,
  UsageRosterPanel,
  UsageRow
} from './UsageRosterPanel'
import { buildClaudeSwitcherAccountRows } from './claude-switcher-account-rows'

const signedOutCodex: ProviderRateLimits = {
  provider: 'codex',
  session: null,
  weekly: null,
  updatedAt: 0,
  error: 'ChatGPT authentication required to read rate limits',
  status: 'error'
}

describe('UsageRow', () => {
  beforeEach(() => {
    mocks.useResetCountdownClock.mockClear()
  })

  it('renders sign-in as row copy instead of nesting an interactive button', () => {
    const markup = renderToStaticMarkup(
      <UsageRow
        p={signedOutCodex}
        display="used"
        state={{ kind: 'sign-in', statusLabel: 'not signed in' }}
        showSignInAction
        now={mocks.now}
      />
    )

    expect(markup).toContain('not signed in')
    expect(markup).toContain('Sign in')
    expect(markup).not.toContain('<button')
  })

  it('keeps the bar fill consistent with the remaining percentage label', () => {
    const markup = renderToStaticMarkup(
      <UsageRow
        p={{
          ...signedOutCodex,
          session: {
            usedPercent: 25,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          },
          status: 'ok',
          error: null
        }}
        display="remaining"
        state={{ kind: 'usage', statusLabel: null }}
        showSignInAction={false}
        now={mocks.now}
      />
    )

    expect(markup).toContain('75%')
    expect(markup).toContain('width:75%')
    expect(markup).not.toContain('width:25%')
  })

  it('uses one shared clock for live reset labels across the roster', () => {
    const sessionReset = mocks.now + 2 * 60_000
    const weeklyReset = mocks.now + 7 * 24 * 60 * 60_000
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <UsageRosterPanel
          providers={[
            {
              ...signedOutCodex,
              session: {
                usedPercent: 25,
                windowMinutes: 300,
                resetsAt: sessionReset,
                resetDescription: null
              },
              weekly: {
                usedPercent: 10,
                windowMinutes: 10_080,
                resetsAt: weeklyReset,
                resetDescription: null
              },
              status: 'ok',
              error: null
            }
          ]}
          display="used"
          statusBarUsageMode="verbose"
          onStatusBarUsageModeChange={() => {}}
          isRefreshing={false}
          onRefresh={() => {}}
          onOpenProvider={() => {}}
          onSignIn={() => {}}
          canSignIn={() => true}
          onManageAccounts={() => {}}
          onUsageDetails={() => {}}
        />
      </TooltipProvider>
    )

    expect(mocks.useResetCountdownClock).toHaveBeenCalledOnce()
    expect(mocks.useResetCountdownClock).toHaveBeenCalledWith([sessionReset, weeklyReset])
    expect(markup).toContain('Resets in 2m')
    expect(markup).toContain('5h')
    expect(markup).toContain('25%')
    expect(markup).toContain('wk')
    expect(markup).toContain('10%')
  })

  it('renders the tightest window inline in compact mode', () => {
    const markup = renderToStaticMarkup(
      <UsageRow
        p={{
          ...signedOutCodex,
          session: {
            usedPercent: 25,
            windowMinutes: 300,
            resetsAt: mocks.now + 2 * 60_000,
            resetDescription: null
          },
          weekly: {
            usedPercent: 60,
            windowMinutes: 10_080,
            resetsAt: mocks.now + 7 * 24 * 60 * 60_000,
            resetDescription: null
          },
          status: 'ok',
          error: null
        }}
        display="used"
        mode="compact"
        state={{ kind: 'usage', statusLabel: null }}
        showSignInAction={false}
        now={mocks.now}
      />
    )

    expect(markup).toContain('data-usage-mode="compact"')
    expect(markup.match(/data-usage-window=/g)).toHaveLength(1)
    expect(markup).not.toContain('data-usage-bar')
    expect(markup).toContain('60%')
    expect(markup).not.toContain('25%')
    expect(markup).not.toContain('Resets in')
  })

  it('uses the same compact selection for Claude subscription windows', () => {
    const markup = renderToStaticMarkup(
      <UsageRow
        p={{
          provider: 'claude',
          session: {
            usedPercent: 25,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          },
          weekly: {
            usedPercent: 60,
            windowMinutes: 10_080,
            resetsAt: null,
            resetDescription: null
          },
          fableWeekly: {
            usedPercent: 75,
            windowMinutes: 10_080,
            resetsAt: null,
            resetDescription: null
          },
          updatedAt: 0,
          status: 'ok',
          error: null
        }}
        display="used"
        mode="compact"
        state={{ kind: 'usage', statusLabel: null }}
        showSignInAction={false}
        now={mocks.now}
      />
    )

    expect(markup.match(/data-usage-window=/g)).toHaveLength(1)
    expect(markup).not.toContain('data-usage-bar')
    expect(markup).toContain('Fable')
    expect(markup).toContain('75%')
    expect(markup).not.toContain('25%')
    expect(markup).not.toContain('60%')
  })

  it('renders every window below the header in verbose mode', () => {
    const markup = renderToStaticMarkup(
      <UsageRow
        p={{
          ...signedOutCodex,
          session: {
            usedPercent: 25,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          },
          weekly: {
            usedPercent: 60,
            windowMinutes: 10_080,
            resetsAt: null,
            resetDescription: null
          },
          status: 'ok',
          error: null
        }}
        display="used"
        state={{ kind: 'usage', statusLabel: null }}
        showSignInAction={false}
        now={mocks.now}
      />
    )

    expect(markup).toContain('data-usage-mode="verbose"')
    expect(markup.match(/data-usage-window=/g)).toHaveLength(2)
    expect(markup.match(/data-usage-bar/g)).toHaveLength(2)
    expect(markup).toContain('25%')
    expect(markup).toContain('60%')
  })
})

describe('UsageRow windows that reset since the last check', () => {
  const FETCHED = mocks.now - 60 * 60_000

  function claudeFetchedAt(weeklyResetsAt: number | null): ProviderRateLimits {
    return {
      provider: 'claude',
      session: { usedPercent: 25, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: {
        usedPercent: 63,
        windowMinutes: 10_080,
        resetsAt: weeklyResetsAt,
        resetDescription: null
      },
      updatedAt: FETCHED,
      error: null,
      status: 'ok'
    }
  }

  function renderRow(p: ProviderRateLimits): string {
    return renderToStaticMarkup(
      <UsageRow
        p={p}
        display="used"
        state={{ kind: 'usage', statusLabel: null }}
        showSignInAction={false}
        now={mocks.now}
      />
    )
  }

  it('shows "reset since last check" instead of the old percentage', () => {
    const markup = renderRow(claudeFetchedAt(FETCHED + 10 * 60_000))

    expect(markup).toContain('reset since last check')
    expect(markup.match(/data-usage-reset-since-check/g)).toHaveLength(1)
    expect(markup).not.toContain('63%')
    // The other window is unaffected.
    expect(markup).toContain('25%')
  })

  it('keeps the percentage while the reset is still ahead', () => {
    const markup = renderRow(claudeFetchedAt(mocks.now + 60_000))

    expect(markup).toContain('63%')
    expect(markup).not.toContain('reset since last check')
  })

  it('keeps the percentage when the reset predates the fetch', () => {
    const markup = renderRow(claudeFetchedAt(FETCHED - 60_000))

    expect(markup).toContain('63%')
    expect(markup).not.toContain('reset since last check')
  })
})

describe('getTightestUsageSection and windows reset since the last check', () => {
  const FETCHED = mocks.now - 60 * 60_000
  const PASSED = FETCHED + 10 * 60_000

  function claude(
    session: { used: number; resetsAt: number | null },
    weekly: { used: number; resetsAt: number | null }
  ): ProviderRateLimits {
    return {
      provider: 'claude',
      session: {
        usedPercent: session.used,
        windowMinutes: 300,
        resetsAt: session.resetsAt,
        resetDescription: null
      },
      weekly: {
        usedPercent: weekly.used,
        windowMinutes: 10_080,
        resetsAt: weekly.resetsAt,
        resetDescription: null
      },
      updatedAt: FETCHED,
      error: null,
      status: 'ok'
    }
  }

  it('skips a window that reset since the data was fetched, however high its old percentage', () => {
    const tightest = getTightestUsageSection(
      claude({ used: 95, resetsAt: PASSED }, { used: 40, resetsAt: mocks.now + 60_000 }),
      mocks.now
    )

    expect(tightest?.window.usedPercent).toBe(40)
  })

  it('still ranks a high window whose reset is ahead or predates the fetch (positive control)', () => {
    expect(
      getTightestUsageSection(
        claude({ used: 95, resetsAt: mocks.now + 60_000 }, { used: 40, resetsAt: null }),
        mocks.now
      )?.window.usedPercent
    ).toBe(95)
    expect(
      getTightestUsageSection(
        claude({ used: 95, resetsAt: FETCHED - 60_000 }, { used: 40, resetsAt: null }),
        mocks.now
      )?.window.usedPercent
    ).toBe(95)
  })

  it('returns null when every window has reset', () => {
    expect(
      getTightestUsageSection(
        claude({ used: 95, resetsAt: PASSED }, { used: 40, resetsAt: PASSED }),
        mocks.now
      )
    ).toBeNull()
  })
})

describe('UsageRosterPanel density picker', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mocks.useResetCountdownClock.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function renderPanel(
    statusBarUsageMode: 'verbose' | 'compact',
    onStatusBarUsageModeChange: (mode: 'verbose' | 'compact') => void
  ): void {
    act(() => {
      root.render(
        <TooltipProvider>
          <UsageRosterPanel
            providers={[]}
            display="used"
            statusBarUsageMode={statusBarUsageMode}
            onStatusBarUsageModeChange={onStatusBarUsageModeChange}
            isRefreshing={false}
            onRefresh={() => {}}
            onOpenProvider={() => {}}
            onSignIn={() => {}}
            canSignIn={() => true}
            onManageAccounts={() => {}}
            onUsageDetails={() => {}}
          />
        </TooltipProvider>
      )
    })
  }

  function segmentButton(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === label
    )
    if (!button) {
      throw new Error(`missing "${label}" segment`)
    }
    return button as HTMLButtonElement
  }

  it('offers named Detailed/Compact segments and marks the active one', () => {
    renderPanel('compact', () => {})

    expect(container.textContent).toContain('Detailed')
    expect(container.textContent).toContain('Compact')
    expect(segmentButton('Compact').getAttribute('aria-checked')).toBe('true')
    expect(segmentButton('Detailed').getAttribute('aria-checked')).toBe('false')
  })

  it('switches mode when a segment is chosen', () => {
    const onStatusBarUsageModeChange = vi.fn()
    renderPanel('compact', onStatusBarUsageModeChange)

    act(() => {
      segmentButton('Detailed').click()
    })
    expect(onStatusBarUsageModeChange).toHaveBeenLastCalledWith('verbose')

    act(() => {
      segmentButton('Compact').click()
    })
    expect(onStatusBarUsageModeChange).toHaveBeenLastCalledWith('compact')
  })
})

describe('UsageRosterPanel per-account Claude rows', () => {
  const NOW = 1_000_000_000

  function claudeWith(
    sessionPercent: number,
    overrides: Partial<ProviderRateLimits> = {}
  ): ProviderRateLimits {
    return {
      provider: 'claude',
      session: {
        usedPercent: sessionPercent,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      weekly: { usedPercent: 10, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
      updatedAt: NOW,
      error: null,
      status: 'ok',
      ...overrides
    }
  }

  function rowsFor(
    inactive: Parameters<typeof buildClaudeSwitcherAccountRows>[3]
  ): ReturnType<typeof buildClaudeSwitcherAccountRows> {
    return buildClaudeSwitcherAccountRows(
      [
        { id: 'acct-active', label: 'active@example.com', active: true },
        { id: 'acct-b', label: 'b@example.com', active: false },
        { id: 'acct-c', label: 'c@example.com', active: false }
      ],
      claudeWith(40),
      true,
      inactive,
      NOW
    )
  }

  function renderPanel(
    rows: ReturnType<typeof buildClaudeSwitcherAccountRows>,
    providers: ProviderRateLimits[]
  ): string {
    return renderToStaticMarkup(
      <TooltipProvider>
        <UsageRosterPanel
          providers={providers}
          display="used"
          statusBarUsageMode="verbose"
          onStatusBarUsageModeChange={() => {}}
          isRefreshing={false}
          onRefresh={() => {}}
          onOpenProvider={() => {}}
          onSignIn={() => {}}
          canSignIn={() => true}
          onManageAccounts={() => {}}
          onUsageDetails={() => {}}
          renderRowDetails={(p) =>
            p.provider === 'claude' ? (
              <ClaudeAccountUsageList
                rows={rows}
                formatAge={(ageMs) => `${Math.round(ageMs / 60_000)} min ago`}
                now={NOW}
                renderUsage={(row) => (
                  <span data-test-usage={row.id}>
                    {row.limits ? `${row.limits.session?.usedPercent}% bars` : 'skeleton'}
                  </span>
                )}
              />
            ) : null
          }
        />
      </TooltipProvider>
    )
  }

  it('lists every saved Claude account under the Claude row with the active one marked', () => {
    const rows = rowsFor([
      {
        accountId: 'acct-b',
        rateLimits: claudeWith(77, { updatedAt: NOW - 5 * 60_000 }),
        updatedAt: NOW - 5 * 60_000,
        isFetching: false
      },
      {
        accountId: 'acct-c',
        rateLimits: claudeWith(12, { updatedAt: NOW - 60_000 }),
        updatedAt: NOW - 60_000,
        isFetching: false
      }
    ])
    const markup = renderPanel(rows, [claudeWith(40), signedOutCodex])

    for (const id of ['acct-active', 'acct-b', 'acct-c']) {
      expect(markup).toContain(`data-claude-account-row="${id}"`)
    }
    expect(markup).toContain('active@example.com')
    expect(markup).toContain('b@example.com')
    expect(markup).toContain('c@example.com')
    expect(markup).toContain('data-test-usage="acct-b">77% bars')
    expect(markup).toContain('updated 5 min ago')
    // Only the active account is marked.
    expect(markup.match(/data-active="true"/g)).toHaveLength(1)
    expect(markup).toMatch(/data-claude-account-row="acct-active"\s+data-active="true"/)
    expect(markup.match(/>Active</g)).toHaveLength(1)
    // Listed beneath the Claude provider row, and only there.
    expect(markup.match(/data-claude-account-usage-list/g)).toHaveLength(1)
    expect(markup.indexOf('Claude')).toBeLessThan(markup.indexOf('data-claude-account-usage-list'))
  })

  it('shows "No usage yet" for an account with no snapshot and a skeleton while it is fetching', () => {
    const rows = rowsFor([
      { accountId: 'acct-c', rateLimits: null, updatedAt: 0, isFetching: true }
    ])
    const markup = renderPanel(rows, [claudeWith(40)])

    // acct-b has no cache entry at all; acct-c is still loading.
    expect(markup).toMatch(
      /data-claude-account-row="acct-b"[\s\S]*?No usage yet[\s\S]*?data-claude-account-row="acct-c"/
    )
    expect(markup).toContain('data-test-usage="acct-c">skeleton')
    expect(markup.match(/No usage yet/g)).toHaveLength(1)
    // No age caption for rows without a snapshot to date.
    expect(markup.match(/updated /g)).toHaveLength(1)
  })

  it('says why a kept snapshot is not fresh', () => {
    const rows = rowsFor([
      {
        accountId: 'acct-b',
        rateLimits: claudeWith(55, {
          status: 'error',
          error: 'waiting',
          usageMetadata: { failureKind: 'deferred-by-live-session' }
        }),
        updatedAt: NOW,
        isFetching: false
      }
    ])
    const markup = renderPanel(rows, [claudeWith(40)])

    expect(markup).toContain('Waiting for Claude session')
  })

  it('renders no list when there are no saved accounts', () => {
    const markup = renderPanel([], [claudeWith(40)])

    expect(markup).not.toContain('data-claude-account-usage-list')
  })

  it('leaves non-Claude provider rows unchanged', () => {
    const rows = rowsFor([])
    const markup = renderPanel(rows, [signedOutCodex])

    expect(markup).not.toContain('data-claude-account-usage-list')
  })
  it('says how old the data is, when it was last checked, and why when the latest attempt failed', () => {
    const rows = rowsFor([
      {
        accountId: 'acct-b',
        rateLimits: claudeWith(55, {
          status: 'error',
          error: 'waiting',
          updatedAt: NOW - 30 * 60_000,
          usageMetadata: { failureKind: 'network', lastAttemptAt: NOW - 2 * 60_000 }
        }),
        updatedAt: NOW - 30 * 60_000,
        isFetching: false
      }
    ])
    const markup = renderPanel(rows, [claudeWith(40)])

    expect(markup).toContain('data 30 min ago · checked 2 min ago · Network issue')
  })

  it('shows only when it was checked for a failure with no numbers to keep', () => {
    const rows = rowsFor([
      {
        accountId: 'acct-b',
        rateLimits: {
          provider: 'claude',
          session: null,
          weekly: null,
          updatedAt: NOW - 4 * 60_000,
          error: 'boom',
          status: 'error'
        },
        updatedAt: NOW - 4 * 60_000,
        isFetching: false
      }
    ])
    const markup = renderPanel(rows, [claudeWith(40)])

    expect(markup).toContain('checked 4 min ago')
    expect(markup).not.toContain('data ')
  })
})
