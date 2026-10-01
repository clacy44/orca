// R315: which lost panes are chairs, decided in main from host facts and sent to the renderer as a
// boolean only. A chair has a non-derived, non-tombstoned registered row AND a host-scoped manifest
// entry matching by `name === display_name` or `chairTargetSessionId === newest launch session`.
// Any failure reads as "not a chair" (resume without a prompt).
import type { AgentLaunchSessionRow } from './agent-launch-sessions'
import type { ChairsManifestEntry } from './chairs-manifest'
import { chairTargetSessionId } from './chairs-restore-plan'
import type { AgentRow } from './types'

export type DaemonLossChairDb = {
  getAgentByPaneKey(hostId: string, paneKey: string): AgentRow | undefined
  newestLaunchForPane(hostId: string, paneKey: string): AgentLaunchSessionRow | undefined
}

export function chairForPane(
  db: DaemonLossChairDb,
  hostId: string,
  paneKey: string,
  hostScopedChairs: readonly ChairsManifestEntry[] | null
): ChairsManifestEntry | null {
  if (!hostScopedChairs || hostScopedChairs.length === 0) {
    return null
  }
  try {
    const row = db.getAgentByPaneKey(hostId, paneKey)
    if (!row || row.derived !== 0 || row.tombstoned_at !== null) {
      return null
    }
    const sessionId = db.newestLaunchForPane(hostId, paneKey)?.session_id
    return (
      hostScopedChairs.find(
        (chair) =>
          chair.name === row.display_name ||
          (sessionId !== undefined && chairTargetSessionId(chair) === sessionId)
      ) ?? null
    )
  } catch {
    return null
  }
}

export type DaemonLossRecoveryPlanEntry = {
  id: string
  paneKey: string | null
  /** A peer-owned attachment pane is closed by the exit semantics, never relaunched. */
  peerOwned: boolean
  reanchor: boolean
}

export function planDaemonLossRecovery(args: {
  db: DaemonLossChairDb | null
  hostId: string
  hostScopedChairs: readonly ChairsManifestEntry[] | null
  sessions: readonly { id: string }[]
  paneKeyOf: (ptyId: string) => string | null
  isPeerOwned: (ptyId: string) => boolean
}): DaemonLossRecoveryPlanEntry[] {
  return args.sessions.map(({ id }) => {
    const paneKey = args.paneKeyOf(id)
    const peerOwned = args.isPeerOwned(id)
    const reanchor =
      !peerOwned &&
      paneKey !== null &&
      args.db !== null &&
      chairForPane(args.db, args.hostId, paneKey, args.hostScopedChairs) !== null
    return { id, paneKey, peerOwned, reanchor }
  })
}
