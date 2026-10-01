// R316: host half of the agent-sleep guard. Registered/chair status and background work are known
// only in main; a pane may sleep only when unprotected AND its verdict is explicitly 'idle'.
import type { AgentLaunchSessionRow } from './agent-launch-sessions'
import { chairTargetSessionId } from './chairs-restore-plan'
import { readHostScopedManifestChairsStrict } from './chair-succession-manifest-entry'
import type { AgentRow } from './types'
import type {
  BackgroundWorkVerdict,
  HibernationGuardSnapshot
} from '../../../shared/hibernation-guard-types'

/** The two reads the guard needs; `OrchestrationDb` satisfies this as-is. */
export type HibernationGuardDb = {
  listAgentsByPaneKeySuffix(hostId: string, paneKey: string): AgentRow[]
  newestLaunchForPane(hostId: string, paneKey: string): AgentLaunchSessionRow | undefined
}

/**
 * Protected: panes held by a non-derived registered row (quarantined included, matched by pane
 * suffix so a tab move cannot unprotect), and panes whose newest launch row holds a host-scoped
 * manifest chair's session. A db read or an unreadable manifest throws, so the caller fails closed.
 */
export async function computeHibernationGuard(
  db: HibernationGuardDb,
  hostId: string,
  paneKeys: readonly string[],
  verdictOf: (paneKey: string) => BackgroundWorkVerdict
): Promise<HibernationGuardSnapshot> {
  const chairs = await readHostScopedManifestChairsStrict()
  const chairSessions = new Set(chairs.map(chairTargetSessionId))
  const protectedPaneKeys: string[] = []
  const backgroundWork: Record<string, BackgroundWorkVerdict> = {}
  for (const paneKey of paneKeys) {
    backgroundWork[paneKey] = verdictOf(paneKey)
    const registered = db
      .listAgentsByPaneKeySuffix(hostId, paneKey)
      .some((row) => row.derived === 0)
    const newest = chairSessions.size > 0 ? db.newestLaunchForPane(hostId, paneKey) : undefined
    if (registered || (newest !== undefined && chairSessions.has(newest.session_id))) {
      protectedPaneKeys.push(paneKey)
    }
  }
  return { protectedPaneKeys, backgroundWork }
}
