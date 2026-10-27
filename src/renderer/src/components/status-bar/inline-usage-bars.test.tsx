import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null
}))

const mocks = vi.hoisted(() => ({
  usagePercentageDisplay: 'used' as 'used' | 'remaining'
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' | 'remaining' }) => unknown) =>
    selector({ usagePercentageDisplay: mocks.usagePercentageDisplay })
}))

function claudeLimits(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: {
      usedPercent: 32,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: {
      usedPercent: 16,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null
    },
    fableWeekly: {
      usedPercent: 42,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null
    },
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

describe('InlineUsageBars', () => {
  beforeEach(() => {
    mocks.usagePercentageDisplay = 'used'
  })

  it('renders Claude Fable usage in inactive account preview rows', async () => {
    const { InlineUsageBars } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <InlineUsageBars limits={claudeLimits()} isFetching={false} />
    )

    // Why: bars show % used with explicit "used" so compact labels are not ambiguous.
    expect(markup).toContain('32% used 5h')
    expect(markup).toContain('16% used wk')
    expect(markup).toContain('42% used Fable')
  })

  it('derives the collapsed session label from resetsAt (#5399)', async () => {
    const { InlineUsageBars } = await import('./StatusBar')

    const limits = claudeLimits()
    // ~1h 20m away; +5s buffer keeps the floor-based formatter at '1h 20m'
    // across the few ms between snapshot and render.
    limits.session!.resetsAt = Date.now() + 80 * 60_000 + 5_000

    const markup = renderToStaticMarkup(<InlineUsageBars limits={limits} isFetching={false} />)

    expect(markup).toContain('32% used 1h 20m')
    expect(markup).not.toContain('32% used 5h')
    // Non-session bars keep their fixed labels.
    expect(markup).toContain('16% used wk')
    expect(markup).toContain('42% used Fable')
  })

  it('shows "now" for an already-expired session reset', async () => {
    const { InlineUsageBars } = await import('./StatusBar')

    const limits = claudeLimits()
    limits.session!.resetsAt = Date.now() - 1000

    const markup = renderToStaticMarkup(<InlineUsageBars limits={limits} isFetching={false} />)

    expect(markup).toContain('32% used now')
  })

  it('keeps the footer meter for weekly-only Codex usage', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const limits: ProviderRateLimits = {
      provider: 'codex',
      session: null,
      weekly: {
        usedPercent: 37,
        windowMinutes: 10_080,
        resetsAt: null,
        resetDescription: null
      },
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }

    const markup = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={false} display="used" />
    )

    expect(markup).toContain('w-[48px] h-[6px]')
    expect(markup).toContain('width:37%')
    expect(markup).toContain('37% used wk')
  })

  it('shows remaining copy and remaining meter fill', async () => {
    mocks.usagePercentageDisplay = 'remaining'
    const { InlineUsageBars } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <InlineUsageBars limits={claudeLimits()} isFetching={false} />
    )

    expect(markup).toContain('68% left 5h')
    expect(markup).toContain('84% left wk')
    expect(markup).toContain('58% left Fable')
    expect(markup).toContain('width:68%')
    expect(markup).toContain('width:84%')
    expect(markup).toContain('width:58%')
    expect(markup).not.toContain('width:32%')
  })
  it('shows a countdown under the weekly and Fable bars when their resets are known', async () => {
    const { InlineUsageBars } = await import('./StatusBar')

    const limits = claudeLimits()
    // +5s keeps the floor-based formatter stable across the few ms between snapshot and render.
    limits.weekly!.resetsAt = Date.now() + (3 * 24 * 60 + 2 * 60) * 60_000 + 5_000
    limits.fableWeekly!.resetsAt = Date.now() + 90 * 60_000 + 5_000

    const markup = renderToStaticMarkup(<InlineUsageBars limits={limits} isFetching={false} />)

    expect(markup).toContain('Resets in 3d 2h')
    expect(markup).toContain('Resets in 1h 30m')
    // The bars keep their identifying labels; the session countdown stays in its own label.
    expect(markup).toContain('16% used wk')
    expect(markup).toContain('42% used Fable')
    expect(markup.match(/data-usage-reset-caption/g)).toHaveLength(2)
  })

  it('omits reset captions when no reset time is known', async () => {
    const { InlineUsageBars } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <InlineUsageBars limits={claudeLimits()} isFetching={false} />
    )

    expect(markup).not.toContain('data-usage-reset-caption')
    expect(markup).not.toContain('Resets in')
  })

  describe('empty-bar status copy per failure kind', () => {
    function errorLimits(
      failureKind: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind'],
      error = 'boom'
    ): ProviderRateLimits {
      return {
        provider: 'claude',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error,
        status: 'error',
        usageMetadata: failureKind ? { failureKind } : undefined
      }
    }

    async function render(limits: ProviderRateLimits): Promise<string> {
      const { InlineUsageBars } = await import('./StatusBar')
      return renderToStaticMarkup(<InlineUsageBars limits={limits} isFetching={false} />)
    }

    it('keeps "Sign in to see usage" only for missing credentials', async () => {
      expect(await render(errorLimits('missing-credentials', 'No credentials'))).toContain(
        'Sign in to see usage'
      )
    })

    it.each([
      ['deferred-by-live-session', 'Waiting for Claude session'],
      ['stale-token', 'Refreshing sign-in'],
      ['network', 'Network issue'],
      ['keychain-unavailable', 'Sign-in unavailable'],
      ['usage-unavailable', 'Usage unavailable'],
      ['server', 'Refresh failed'],
      [undefined, 'Refresh failed']
    ] as const)('labels %s as "%s" instead of a sign-in prompt', async (failureKind, label) => {
      const markup = await render(errorLimits(failureKind))

      expect(markup).toContain(label)
      expect(markup).not.toContain('Sign in to see usage')
    })

    it('labels a rate-limited account as Limited', async () => {
      const markup = await render(
        errorLimits('rate-limited', 'Claude usage is rate limited right now.')
      )

      expect(markup).toContain('Limited')
      expect(markup).not.toContain('Sign in to see usage')
    })
  })
})
