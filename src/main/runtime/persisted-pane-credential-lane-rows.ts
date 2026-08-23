import type {
  PersistedPaneCredentialLane,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'

/**
 * Pane→lane rows are host-owned and write-once (S9 §2a/§2h).
 *
 * The renderer authors most of the workspace session, and its writes carry no lane rows at all; a
 * plain replace would orphan every live lane pane into `unknown`. Prior rows therefore win, and an
 * incoming row is kept only for a pane the host has not already bound.
 */
export function mergePersistedPaneCredentialLanes(
  session: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined | null
): WorkspaceSessionState {
  const priorRows = prior?.terminalCredentialLanesByPaneKey
  if (!priorRows || Object.keys(priorRows).length === 0) {
    return session
  }
  const merged: Record<string, PersistedPaneCredentialLane> = {
    ...session.terminalCredentialLanesByPaneKey,
    ...priorRows
  }
  return { ...session, terminalCredentialLanesByPaneKey: merged }
}
