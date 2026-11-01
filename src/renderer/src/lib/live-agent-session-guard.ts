import type { AppState } from '@/store/types'
import {
  liveAgentSessionKey,
  type LiveAgentSessionMark
} from '../../../shared/sweep-restore-mark-list'
import { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'

type LiveAgentGuardState = Pick<AppState, 'liveAgentSessionPaneKeys' | 'liveAgentSessionKeys'>

/** The marks (keyed by holding pty) plus the two lookup sets the guards read, all derived from them. */
export function deriveLiveAgentSessionState(
  marksByPtyId: Readonly<Record<string, readonly LiveAgentSessionMark[]>>
): Pick<
  AppState,
  'liveAgentSessionMarksByPtyId' | 'liveAgentSessionPaneKeys' | 'liveAgentSessionKeys'
> {
  const marks = Object.values(marksByPtyId).flat()
  return {
    liveAgentSessionMarksByPtyId: marksByPtyId,
    liveAgentSessionPaneKeys: new Set(marks.map((mark) => mark.paneKey)),
    liveAgentSessionKeys: new Set(
      marks.map((mark) => liveAgentSessionKey(mark.worktreeId, mark.agent, mark.providerSessionId))
    )
  }
}

type LiveAgentGuardRecord = {
  paneKey: string
  worktreeId: string
  agent: string
  providerSession: { id: string }
}

/** True when a live local terminal in main's inventory holds this record's conversation, by pane or by session. */
export function isHeldByLiveAgentTerminal(
  state: LiveAgentGuardState,
  record: LiveAgentGuardRecord
): boolean {
  return (
    (state.liveAgentSessionPaneKeys?.has(record.paneKey) ?? false) ||
    (state.liveAgentSessionKeys?.has(
      liveAgentSessionKey(record.worktreeId, record.agent, record.providerSession.id)
    ) ??
      false)
  )
}

/** True when a live terminal OTHER than this pane holds the conversation (the pane's own live mark never blocks it). */
export function isHeldByOtherLiveAgentTerminal(
  state: LiveAgentGuardState,
  pane: { paneKey: string; worktreeId: string; agent: string; providerSessionId: string }
): boolean {
  return (
    !(state.liveAgentSessionPaneKeys?.has(pane.paneKey) ?? false) &&
    (state.liveAgentSessionKeys?.has(
      liveAgentSessionKey(pane.worktreeId, pane.agent, pane.providerSessionId)
    ) ??
      false)
  )
}

export function recordLiveAgentResumeSkipped(source: string, paneKey: string): void {
  recordRendererCrashBreadcrumb('live_agent_session_resume_skipped', { source, paneKey })
}
