// Why the title is resolved here and not host-side: W9 publishes ids, because a tab title is renderer
// display state that changes without a selection changing. Joining against the snapshot the selection
// arrived on is what keeps the two consistent — a later snapshot cannot rename a tab out from under it.
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { TerminalPresenceSelection } from '@/lib/pane-manager/terminal-presence-state'

export function toTerminalPresenceSelections(
  snapshot: RuntimeMobileSessionTabsResult
): TerminalPresenceSelection[] {
  // Why not an early return on an absent key: an old host publishes nothing, and "nobody is selecting
  // anything here" is the honest render of that.
  const titlesByTabId = new Map(snapshot.tabs.map((tab) => [tab.id, tab.title]))
  return (snapshot.deviceSelections ?? []).map((selection) => ({
    ...selection,
    activeTabTitle: titlesByTabId.get(selection.activeTabId) ?? null
  }))
}
