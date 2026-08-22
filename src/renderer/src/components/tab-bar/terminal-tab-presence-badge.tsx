import { useEffect, useState, type ReactElement } from 'react'
import { onPresenceChange } from '@/lib/pane-manager/terminal-presence-state'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import {
  resolveTerminalTabPresenceBadge,
  resolveTerminalTabPresenceLabel,
  type TerminalTabPresenceBadgeState
} from './terminal-tab-presence-status'

// Why monochrome: the strip already spends its colour on agent state, and presence is ambient.
const DOT_CLASSES: Record<TerminalTabPresenceBadgeState, string> = {
  typing: 'bg-foreground',
  writing: 'bg-muted-foreground',
  attached: 'bg-muted-foreground/50'
}

function badgeTitle(state: TerminalTabPresenceBadgeState, label: string): string {
  switch (state) {
    case 'typing':
      return translate(
        'auto.components.tab.bar.terminal.tab.presence.badge.2561fd4563',
        '{{value0}} is typing in this tab',
        { value0: label }
      )
    case 'writing':
      return translate(
        'auto.components.tab.bar.terminal.tab.presence.badge.407e0165e2',
        '{{value0}} is writing in this tab',
        { value0: label }
      )
    case 'attached':
      return translate(
        'auto.components.tab.bar.terminal.tab.presence.badge.4f7a82c1d5',
        '{{value0}} is using this tab',
        { value0: label }
      )
  }
}

/** Trailing-slot presence dot. The leading icon slot is single-occupancy with a fixed precedence, so a
 *  peer marker there would silently displace the agent glyph. */
export function TerminalTabPresenceBadge({ tabId }: { tabId: string }): ReactElement | null {
  // Why a counter: presence lives outside the store, so nothing else would re-render this tab on a
  // peer's typing edge.
  const [, setPresenceTick] = useState(0)
  useEffect(
    () =>
      onPresenceChange((event) => {
        const ptyIds = useAppStore.getState().ptyIdsByTabId?.[tabId] ?? []
        if (!ptyIds.includes(event.ptyId)) {
          return
        }
        setPresenceTick((n) => n + 1)
      }),
    [tabId]
  )
  const badge = useAppStore((s) =>
    resolveTerminalTabPresenceBadge({ tabId, ptyIdsByTabId: s.ptyIdsByTabId })
  )
  if (!badge) {
    return null
  }
  const label = resolveTerminalTabPresenceLabel({
    tabId,
    ptyIdsByTabId: useAppStore.getState().ptyIdsByTabId
  })
  const title = label ? badgeTitle(badge, label) : undefined
  return (
    <span
      className={`mr-1 size-1.5 shrink-0 rounded-full ${DOT_CLASSES[badge]}`}
      data-tab-presence={badge}
      title={title}
      aria-label={title}
    />
  )
}
