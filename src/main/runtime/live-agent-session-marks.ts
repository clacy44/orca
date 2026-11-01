import type { LiveAgentSessionMark } from '../../shared/sweep-restore-mark-list'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'

export type LiveAgentStatusRow = {
  paneKey: string
  agentType?: string
  providerSession?: { id: string }
  receivedAt: number
  restoredUnconfirmed?: boolean
}

type LaunchBooks = {
  newestLaunchForPane(
    hostId: string,
    paneKey: string
  ): { agent_type: string; session_id: string } | undefined
  paneHoldingSession(hostId: string, sessionId: string): string | undefined
}

// Why: names the agent conversations a live terminal still holds, so no wake path starts a second
// copy of one. Panes come from a fresh controller inventory; sessions from the hook server's latest
// status per pane and from the launch books (only when the books still say the pane holds it).
export function collectLiveAgentSessionMarks(input: {
  livePanes: readonly { ptyId: string; paneKey: string; worktreeId: string }[]
  statuses: readonly LiveAgentStatusRow[]
  books: LaunchBooks | null
  hostId: string
  now: number
}): LiveAgentSessionMark[] {
  const statusByPaneKey = new Map(input.statuses.map((status) => [status.paneKey, status]))
  const marks = new Map<string, LiveAgentSessionMark>()
  const add = (
    ptyId: string,
    paneKey: string,
    worktreeId: string,
    agent: string | undefined,
    providerSessionId: string | undefined
  ): void => {
    if (!agent || !providerSessionId) {
      return
    }
    marks.set(`${paneKey}\0${agent}\0${providerSessionId}`, {
      ptyId,
      paneKey,
      worktreeId,
      agent,
      providerSessionId
    })
  }
  for (const { ptyId, paneKey, worktreeId } of input.livePanes) {
    const status = statusByPaneKey.get(paneKey)
    // Why: a restored, never-reconfirmed row older than the stale bound says nothing about the process.
    const statusIsFresh =
      status !== undefined &&
      !(status.restoredUnconfirmed && status.receivedAt < input.now - AGENT_STATUS_STALE_AFTER_MS)
    if (status && statusIsFresh) {
      add(ptyId, paneKey, worktreeId, status.agentType, status.providerSession?.id)
    }
    const launch = input.books?.newestLaunchForPane(input.hostId, paneKey)
    if (launch && input.books?.paneHoldingSession(input.hostId, launch.session_id) === paneKey) {
      add(ptyId, paneKey, worktreeId, launch.agent_type, launch.session_id)
    }
  }
  return [...marks.values()]
}
