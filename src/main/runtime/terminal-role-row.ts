import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import type { RuntimeTerminalSetRole, RuntimeTerminalSummary } from '../../shared/runtime-types'

function roleLookupPaneKey(
  terminal: Pick<RuntimeTerminalSummary, 'tabId' | 'leafId'>
): string | null {
  return isValidTerminalTabId(terminal.tabId) && isTerminalLeafId(terminal.leafId)
    ? makePaneKey(terminal.tabId, terminal.leafId)
    : null
}

/**
 * Boundary pass over the finished terminal.list array (mirrors terminal-credential-lane-row.ts):
 * only a pass over the result makes the field appear whether the row came from the renderer-graph
 * loop or the PTY fallback loop.
 */
export function applyTerminalRoleRows(
  terminals: RuntimeTerminalSummary[],
  rolesByPaneKey: Readonly<Record<string, string>>
): void {
  for (const terminal of terminals) {
    const paneKey = roleLookupPaneKey(terminal)
    const role = paneKey ? rolesByPaneKey[paneKey] : undefined
    if (role !== undefined) {
      terminal.role = role
    }
  }
}

// Mirrors buildPtyTerminalSummary's orphan check: a headless/background terminal (no
// renderer leaf) still has a stable pane identity via its PTY's paneKey, so role
// assignment doesn't need a live leaf to resolve one (BUG 2 also covers headless).
export function resolvePtyRolePaneTarget(pty: {
  tabId: string | null
  paneKey: string | null
}): { tabId: string; leafId: string } | null {
  const pane = parsePaneKey(pty.paneKey ?? '')
  if (!pty.tabId || !pane || pane.tabId !== pty.tabId) {
    return null
  }
  return { tabId: pty.tabId, leafId: pane.leafId }
}

export type TerminalRoleAssignment = {
  persist: { tabId: string; leafId: string; role: string | null }
  result: RuntimeTerminalSetRole
}

// Why a separate builder: `terminal.setRole`'s runtime method resolves the live leaf for a handle
// (private state), so this stays a pure function of what it resolved to keep that method thin.
export function buildTerminalRoleAssignment(args: {
  handle: string
  tabId: string
  leafId: string
  role: string | null
}): TerminalRoleAssignment {
  return {
    persist: { tabId: args.tabId, leafId: args.leafId, role: args.role },
    result: { handle: args.handle, role: args.role }
  }
}
