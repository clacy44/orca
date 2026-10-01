// [S10-21a C7d, Ruling 34 Addendum 23] One 'daemon_died' audit row per lost pane — the
// host-authored "awaiting restore" fact the post-spawn respawn gate (pty.ts) consumes. Extracted
// from index.ts so R315's crash path and its test drive the SAME writer the restart fanout uses.
import type { AgentLaunchSessionRow } from './agent-launch-sessions'
import { shouldSkipDaemonDiedAudit } from './daemon-died-audit-skip'
import type { AgentRow } from './types'
import type { WriteAgentAuditParams } from './agent-audit-log'

export type DaemonDiedAuditDb = {
  newestLaunchForPane(hostId: string, paneKey: string): AgentLaunchSessionRow | undefined
  getAgentByPaneKey(hostId: string, paneKey: string): AgentRow | undefined
  writeAgentAudit(params: WriteAgentAuditParams): unknown
}

export function writeDaemonDiedAuditRows(args: {
  db: DaemonDiedAuditDb
  hostId: string
  ptyIds: readonly string[]
  paneKeyOf: (ptyId: string) => string | undefined
}): void {
  const { db, hostId } = args
  for (const ptyId of args.ptyIds) {
    const paneKey = args.paneKeyOf(ptyId)
    if (!paneKey) {
      continue
    }
    const row = db.newestLaunchForPane(hostId, paneKey)
    // [S10-21a C7f, D-R114 fix 3] A plain shell with no launch row and no registered agent
    // row on this pane has nothing for the audit to be "about" — skip it rather than write
    // a `daemon_died` fact attributed to an agent that was never here.
    if (
      shouldSkipDaemonDiedAudit(
        row !== undefined,
        row === undefined ? db.getAgentByPaneKey(hostId, paneKey) : undefined
      )
    ) {
      continue
    }
    db.writeAgentAudit({
      agentId: row?.agent_id ?? null,
      actorPaneKey: paneKey,
      actorHostId: hostId,
      verb: 'daemon_died',
      outcome: 'observed',
      reasonCode: `session=${row?.session_id ?? 'unknown'} ptyId=${ptyId}`
    })
  }
}
