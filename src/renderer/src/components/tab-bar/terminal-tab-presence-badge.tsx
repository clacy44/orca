import { useEffect, useState, type ReactElement } from 'react'
import { onPresenceChange } from '@/lib/pane-manager/terminal-presence-state'
import {
  getCredentialLaneForPty,
  onCredentialLaneChange
} from '@/lib/pane-manager/terminal-credential-lane-state'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import {
  resolveTerminalTabPresenceBadge,
  resolveTerminalTabPresenceLabel,
  type TerminalTabPresenceBadgeState
} from './terminal-tab-presence-status'
import { resolveTabCredentialLaneOwnerLabel } from './terminal-tab-credential-lane-owner'

// Why monochrome: the strip already spends its colour on agent state, and presence is ambient.
const DOT_CLASSES: Record<TerminalTabPresenceBadgeState, string> = {
  typing: 'bg-foreground',
  writing: 'bg-muted-foreground',
  attached: 'bg-muted-foreground/50',
  // Why dimmer still: the host has heard nothing from this phone for two minutes, so the dot must not
  // read as loud as somebody who is answering.
  stale: 'bg-muted-foreground/30'
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
    case 'stale':
      return translate(
        'auto.components.tab.bar.terminal.tab.presence.badge.stale',
        '{{value0}} is attached to this tab but has not been seen recently',
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
  // Why a second tick: the credential owner rides the lane store, which changes on its own cadence
  // (terminal.list), so the title must re-resolve when this tab's lane owner changes (S9 §2h).
  useEffect(
    () =>
      onCredentialLaneChange((event) => {
        const ptyIds = useAppStore.getState().ptyIdsByTabId?.[tabId] ?? []
        if (ptyIds.includes(event.ptyId)) {
          setPresenceTick((n) => n + 1)
        }
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
  const ptyIds = useAppStore.getState().ptyIdsByTabId?.[tabId] ?? []
  const ownerLabel = resolveTabCredentialLaneOwnerLabel(
    ptyIds.map((ptyId) => getCredentialLaneForPty(ptyId))
  )
  const presenceTitle = label ? badgeTitle(badge, label) : undefined
  // Why the owner rides the title and not a second dot: the strip is monochrome by design, so the
  // credential owner is awareness on hover, not a new glyph.
  const title =
    ownerLabel !== null
      ? presenceTitle
        ? translate(
            'auto.components.tab.bar.terminal.tab.presence.badge.laneOwnerWithPresence',
            '{{value0}} · runs on {{value1}}',
            { value0: presenceTitle, value1: ownerLabel }
          )
        : translate(
            'auto.components.tab.bar.terminal.tab.presence.badge.laneOwner',
            'Runs on {{value0}}',
            { value0: ownerLabel }
          )
      : presenceTitle
  return (
    <span
      className={`mr-1 size-1.5 shrink-0 rounded-full ${DOT_CLASSES[badge]}`}
      data-tab-presence={badge}
      title={title}
      aria-label={title}
    />
  )
}
