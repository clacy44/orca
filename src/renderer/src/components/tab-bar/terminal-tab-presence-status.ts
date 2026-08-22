// Why a primitive-returning resolver, shaped like terminal-tab-activity-status.ts: Zustand reruns every
// tab's selector on each store write, so the selector must collapse a whole roster to one comparable
// value or an unrelated peer's keystroke repaints every tab in the strip.
import { getPeerPresenceForPty } from '@/lib/pane-manager/terminal-presence-state'

export type TerminalTabPresenceBadgeState = 'typing' | 'writing' | 'attached'

type TerminalTabPresenceInput = {
  tabId: string
  ptyIdsByTabId?: Record<string, string[]>
}

function ptyIdsForTab({ tabId, ptyIdsByTabId }: TerminalTabPresenceInput): string[] {
  return ptyIdsByTabId?.[tabId] ?? []
}

/** Loudest peer state across every pane of the tab, or null when the reader is alone in all of them. */
export function resolveTerminalTabPresenceBadge(
  input: TerminalTabPresenceInput
): TerminalTabPresenceBadgeState | null {
  let badge: TerminalTabPresenceBadgeState | null = null
  for (const ptyId of ptyIdsForTab(input)) {
    for (const peer of getPeerPresenceForPty(ptyId)) {
      if (peer.typing) {
        return 'typing'
      }
      badge = peer.writing ? 'writing' : (badge ?? 'attached')
    }
  }
  return badge
}

/** Read outside the store selector: the badge state is what gates a re-render, and this only runs once
 *  the badge already decided to render. */
export function resolveTerminalTabPresenceLabel(input: TerminalTabPresenceInput): string | null {
  let attached: string | null = null
  let writing: string | null = null
  for (const ptyId of ptyIdsForTab(input)) {
    for (const peer of getPeerPresenceForPty(ptyId)) {
      if (peer.typing) {
        return peer.label
      }
      if (peer.writing) {
        writing ??= peer.label
      }
      attached ??= peer.label
    }
  }
  return writing ?? attached
}
