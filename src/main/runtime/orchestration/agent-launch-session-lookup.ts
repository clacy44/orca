// Artifact 10z.5 R287 (T14): the session-scoped launch-row read `launchBySessionId` cannot give —
// it has neither an order nor a host scope. "Host-scoped" = launch rows with `host_id` = the
// compatibility host AND `execution_host_id` = the workspace's execution host.
import type Database from '../../sqlite/sync-database'
import type { AgentLaunchSessionRow } from './agent-launch-sessions'

export type NewestHostScopedLaunchOptions = {
  /** Skip rows recorded by this pane. */
  excludePaneKey?: string
  /** Only rows already bound to a registered identity. */
  requireAgentId?: boolean
}

export function newestHostScopedLaunchForSession(
  db: Database.Database,
  hostId: string,
  executionHostId: string,
  sessionId: string,
  options: NewestHostScopedLaunchOptions = {}
): AgentLaunchSessionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM agent_launch_sessions
       WHERE host_id = ? AND execution_host_id = ? AND session_id = ?
         AND (? IS NULL OR pane_key <> ?)
         AND (? = 0 OR agent_id IS NOT NULL)
       ORDER BY seq DESC LIMIT 1`
    )
    .get(
      hostId,
      executionHostId,
      sessionId,
      options.excludePaneKey ?? null,
      options.excludePaneKey ?? null,
      options.requireAgentId ? 1 : 0
    ) as AgentLaunchSessionRow | undefined
}
