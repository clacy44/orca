// Why a pure resolver beside the tab badge: a tab's presence dot echoes the credential owner of the
// terminal it holds (S9 §2h) — the same owner label the pane's chip shows — and WHICH owner a tab
// reports when its panes disagree is a rule (the first owned lane wins, a shared/remote/unattributed
// pane contributes none), so it must be assertable without a DOM.
import type { TerminalPaneCredentialLane } from '@/lib/pane-manager/terminal-credential-lane-state'
import { resolveTerminalCredentialLaneAttribution } from '../terminal-pane/terminal-credential-lane-attribution'

/**
 * The credential owner label a tab's badge should carry, or null when no pane in the tab runs on a
 * person's lane. Only an `owned` attribution names a person; a shared/remote/WSL/unattributed pane
 * contributes nothing, so a tab of only those reports no owner.
 */
export function resolveTabCredentialLaneOwnerLabel(
  lanes: readonly TerminalPaneCredentialLane[]
): string | null {
  for (const lane of lanes) {
    const attribution = resolveTerminalCredentialLaneAttribution(lane)
    if (attribution.kind === 'owned') {
      return attribution.account.label
    }
  }
  return null
}
