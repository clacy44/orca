// Artifact 10z.5 R287 (T13, partial): the identity a session is attributed to on this host. Shared
// by the caller-resume admission's audit row (R287 rule 6). Never throws.
import type { AgentRow } from './agent-directory-types'
import type { OrchestrationDb } from './db'

function usableIdentity(row: AgentRow | undefined): AgentRow | undefined {
  return row && row.derived === 0 && row.tombstoned_at === null && row.quarantined === 0
    ? row
    : undefined
}

/** The newest host-scoped launch row for `sessionId` with a non-null `agent_id`, else the
 * session's current holder's registered row; non-derived, non-tombstoned, non-quarantined.
 * `excludePaneKey` drops that pane's launch rows and its holder claim. */
export function attributedIdentityForSession(
  db: OrchestrationDb,
  hostId: string,
  executionHostId: string,
  sessionId: string,
  excludePaneKey?: string
): AgentRow | undefined {
  try {
    const launch = db.newestHostScopedLaunchForSession(hostId, executionHostId, sessionId, {
      excludePaneKey,
      requireAgentId: true
    })
    const fromLaunch = launch?.agent_id
      ? usableIdentity(db.getAgentById(launch.agent_id))
      : undefined
    if (fromLaunch) {
      return fromLaunch
    }
    const holder = db.paneHoldingSession(hostId, sessionId)
    return holder !== undefined && holder !== excludePaneKey
      ? usableIdentity(db.getAgentByPaneKey(hostId, holder))
      : undefined
  } catch {
    return undefined
  }
}
