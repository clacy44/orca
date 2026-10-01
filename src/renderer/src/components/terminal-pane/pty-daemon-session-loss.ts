import { useAppStore } from '@/store'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  ptyDaemonSessionLostHandlers,
  setDaemonSessionsLostSink,
  type DaemonSessionsLostPayload
} from './pty-daemon-session-loss-registry'
import { requestTerminalPaneRecovery } from './terminal-pane-recovery'

const MAX_HANDLED_KEYS = 2048
const handledKeys = new Set<string>()

// Why per death, not per id: a pty id can be reused by a respawn, so only epoch+id names one death.
function markHandled(key: string): boolean {
  if (handledKeys.has(key)) {
    return false
  }
  handledKeys.add(key)
  if (handledKeys.size > MAX_HANDLED_KEYS) {
    handledKeys.delete(handledKeys.values().next().value as string)
  }
  return true
}

function tabHoldsAgentPane(state: ReturnType<typeof useAppStore.getState>, tabId: string): boolean {
  const inTab = (paneKey: string, entryTabId: string | undefined): boolean =>
    (entryTabId ?? parsePaneKey(paneKey)?.tabId) === tabId
  return (
    Object.values(state.agentStatusByPaneKey).some((entry) => inTab(entry.paneKey, entry.tabId)) ||
    Object.values(state.sleepingAgentSessionsByPaneKey).some(
      (record) => record !== undefined && inTab(record.paneKey, record.tabId)
    )
  )
}

function tabIdHoldingPty(
  state: ReturnType<typeof useAppStore.getState>,
  ptyId: string
): string | null {
  for (const [tabId, ptyIds] of Object.entries(state.ptyIdsByTabId ?? {})) {
    if (ptyIds.includes(ptyId)) {
      return tabId
    }
  }
  for (const [tabId, layout] of Object.entries(state.terminalLayoutsByTabId ?? {})) {
    if (Object.values(layout?.ptyIdsByLeafId ?? {}).includes(ptyId)) {
      return tabId
    }
  }
  return null
}

/**
 * R315: recover every pane main reports as lost with the daemon, once. Records for ALL lost panes
 * are captured first (a cooldown on one pane's remount must not strand a sibling's record), then
 * each affected tab is recovered exactly once.
 */
export function handleDaemonSessionsLost(payload: DaemonSessionsLostPayload): void {
  const state = useAppStore.getState()
  const lostByTab = new Map<string, DaemonSessionsLostPayload['sessions']>()
  for (const session of payload.sessions) {
    if (!markHandled(`${payload.epoch}:${session.id}`)) {
      continue
    }
    // Why: a tab already rebound to a new pty was recovered by another trigger.
    const tabId = tabIdHoldingPty(state, session.id)
    if (tabId) {
      lostByTab.set(tabId, [...(lostByTab.get(tabId) ?? []), session])
    }
  }
  for (const sessions of lostByTab.values()) {
    for (const { paneKey, reanchor } of sessions) {
      if (paneKey) {
        try {
          state.captureSleepingAgentSessionForDaemonDeath(paneKey, { reanchor })
        } catch {
          // Best-effort: a capture failure must not block the remount that recovers the pane.
        }
      }
    }
  }
  for (const [tabId, sessions] of lostByTab) {
    const paneKeys = sessions.flatMap(({ paneKey }) => (paneKey ? [paneKey] : []))
    const bound = sessions.find(({ id }) => ptyDaemonSessionLostHandlers.has(id))
    if (bound) {
      ptyDaemonSessionLostHandlers.get(bound.id)?.({ reanchor: bound.reanchor, paneKeys })
      continue
    }
    void requestTerminalPaneRecovery({
      tabId,
      ptyId: sessions[0]?.id ?? null,
      reason: 'daemon-session-lost',
      relaunchPaneKeys: paneKeys
    })
    if (tabHoldsAgentPane(state, tabId)) {
      const worktreeId = Object.entries(state.tabsByWorktree).find(([, tabs]) =>
        tabs.some((tab) => tab.id === tabId)
      )?.[0]
      if (worktreeId) {
        // Why: an unmounted agent tab only relaunches through its own cold restore, so mount it; a no-op when already mounted.
        requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tabId] })
      }
    }
  }
}

/** Idempotent; called once from pty-connection so pane code owns the handling. */
export function installDaemonSessionLossHandling(): void {
  setDaemonSessionsLostSink(handleDaemonSessionsLost)
}

export function _resetDaemonSessionLossForTests(): void {
  handledKeys.clear()
  ptyDaemonSessionLostHandlers.clear()
}
