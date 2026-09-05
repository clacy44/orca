// S10-21a C7b/C7i: the restore sweep's three audit-row shapes, split out of
// restore-registered-agent-panes.ts to stay under the max-lines ratchet.
import type { OrchestrationDb } from './db'

function writeSweepAudit(
  db: OrchestrationDb,
  hostId: string,
  paneKey: string,
  agentId: string,
  verb: string,
  outcome: string,
  reasonCode: string
): void {
  db.writeAgentAudit({
    agentId,
    actorPaneKey: paneKey,
    actorHostId: hostId,
    verb,
    outcome,
    reasonCode
  })
}

export function auditSweepSkip(
  db: OrchestrationDb,
  hostId: string,
  paneKey: string,
  agentId: string,
  reasonCode: string
): void {
  writeSweepAudit(db, hostId, paneKey, agentId, 'sweep_skip', 'deferred', reasonCode)
}

export function auditLayer3(
  db: OrchestrationDb,
  hostId: string,
  paneKey: string,
  agentId: string,
  reasonCode: string
): void {
  writeSweepAudit(db, hostId, paneKey, agentId, 'sweep_layer3', 'deferred', reasonCode)
}

/** [C7h, Ruling 34 Addendum 26] Not a skip — the sweep proceeds to restore. */
export function auditSweepNote(
  db: OrchestrationDb,
  hostId: string,
  paneKey: string,
  agentId: string,
  reasonCode: string
): void {
  writeSweepAudit(db, hostId, paneKey, agentId, 'sweep_note', 'proceeded', reasonCode)
}
