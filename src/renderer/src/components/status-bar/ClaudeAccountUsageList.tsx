import React from 'react'
import { translate } from '@/i18n/i18n'
import type { ClaudeSwitcherAccountRow } from './claude-switcher-account-rows'
import { getProviderUsageStatusLabel } from './usage-error-copy'

// Why: when the latest attempt failed, say how old the numbers are, when we last tried, and why
// they are not fresh (owner ruling R2); a healthy snapshot only needs its age.
function describeAccountFreshness(
  row: ClaudeSwitcherAccountRow,
  hasBars: boolean,
  now: number,
  formatAge: (ageMs: number) => string,
  sweepRetryAt: number | null | undefined
): string | null {
  if (row.ageMs === null || !row.limits) {
    return null
  }
  if (row.limits.status !== 'error') {
    return translate(
      'auto.components.status.bar.UsageRosterPanel.accountUsageUpdated',
      'updated {{value0}}',
      { value0: formatAge(row.ageMs) }
    )
  }
  const checkedAgeMs = Math.max(
    0,
    now - (row.limits.usageMetadata?.lastAttemptAt ?? row.limits.updatedAt)
  )
  if (!hasBars) {
    return translate(
      'auto.components.status.bar.UsageRosterPanel.accountUsageChecked',
      'checked {{value0}}',
      { value0: formatAge(checkedAgeMs) }
    )
  }
  return translate(
    'auto.components.status.bar.UsageRosterPanel.accountUsageDataChecked',
    'data {{value0}} · checked {{value1}} · {{value2}}',
    {
      value0: formatAge(row.ageMs),
      value1: formatAge(checkedAgeMs),
      value2: getProviderUsageStatusLabel(row.limits, { sweepRetryAt, now })
    }
  )
}

/**
 * Every saved Claude account's usage, listed under the Claude provider row.
 *
 * Presentational on purpose: the host owns the account roster, the live clock and the usage bars
 * (they live next to the switcher), this owns only the layout and the honest per-account states —
 * bars, a loading skeleton, or an explicit "No usage yet".
 */
export function ClaudeAccountUsageList({
  rows,
  renderUsage,
  formatAge,
  now,
  sweepRetryAt
}: {
  rows: readonly ClaudeSwitcherAccountRow[]
  renderUsage: (row: ClaudeSwitcherAccountRow) => React.ReactNode
  formatAge: (ageMs: number) => string
  now: number
  // Main's usage-throttling backoff end; feeds the "next check in N min" copy.
  sweepRetryAt?: number | null
}): React.JSX.Element | null {
  if (rows.length === 0) {
    return null
  }
  return (
    <div data-claude-account-usage-list className="flex flex-col gap-2 pb-2.5 pl-[44px] pr-3.5">
      {rows.map((row) => {
        const hasBars = Boolean(
          row.limits?.session || row.limits?.weekly || row.limits?.fableWeekly
        )
        const caption = describeAccountFreshness(row, hasBars, now, formatAge, sweepRetryAt)
        return (
          <div
            key={row.id}
            data-claude-account-row={row.id}
            data-active={row.active ? 'true' : 'false'}
            className="flex min-w-0 flex-col gap-0.5"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                {row.label}
              </span>
              {row.active ? (
                <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                  {translate('auto.components.status.bar.StatusBar.ff0fbe9311', 'Active')}
                </span>
              ) : null}
            </div>
            {row.limits || row.isFetching ? (
              renderUsage(row)
            ) : (
              <span className="text-[10px] text-muted-foreground">
                {translate(
                  'auto.components.status.bar.StatusBar.inactiveUsageNoData',
                  'No usage yet'
                )}
              </span>
            )}
            {caption ? (
              <span className="text-[9px] text-muted-foreground/70">{caption}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
