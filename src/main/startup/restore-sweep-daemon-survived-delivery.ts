// S10-21c B5 (design §2 S7): the `skipped_daemon_survived` arm's own audit + handle-refresh +
// mail-arm step, split out of restore-registered-agent-panes.ts to stay under the max-lines
// ratchet (the module was already at its 300-line cap).
import type { AgentLaunchSessionRow } from '../runtime/orchestration/agent-launch-sessions'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import {
  parseProcessIncarnation,
  type ControllerInventory
} from '../runtime/orchestration/agent-process-identity'
import { auditSweepSkip, auditSweepNote } from '../runtime/orchestration/restore-sweep-audit'
import type { RestoreSweepDeps, RestoreOneOutcome } from './restore-sweep-types'

/** [S10-21c B5, design §2 S7] The daemon kept this pane's pty alive across the restart — the
 * PROCESS needs nothing, but mail already queued against `agent:<id>` is still parked (R5).
 * Audits the skip, then refreshes `terminal_handle` from the SAME controller-inventory identity
 * `decideEarlyRows` already used to reach 'alive' (`inventory.terminalIdentityByPtyId`, never a
 * redundant lookup) and arms delivery — both bound to THIS candidate's own `agentId` (never
 * re-derived by pane suffix, which two rows can share). A throw from either becomes a sweep note,
 * never a failed skip — mirrors how a throw from `notifyRebindDelivery` is handled on the
 * successful-restore arm (restore-registered-agent-panes.ts's own `notifyRebindDelivery` call). */
export function handleDaemonSurvivedSkip(
  db: OrchestrationDb,
  deps: RestoreSweepDeps,
  hostId: string,
  launchRow: AgentLaunchSessionRow,
  agentId: string,
  early: { reasonCode: string },
  processIncarnation: string | null,
  inventory: ControllerInventory | null
): RestoreOneOutcome {
  auditSweepSkip(db, hostId, launchRow.pane_key, agentId, early.reasonCode)
  try {
    const survivedIdentity = parseProcessIncarnation(processIncarnation)
    const controllerIdentity = survivedIdentity
      ? inventory?.terminalIdentityByPtyId.get(survivedIdentity.ptyId)
      : undefined
    if (!controllerIdentity) {
      // Provably unreachable given the caller only reaches this on 'skipped_daemon_survived'
      // (`decideEarlyRows` only returns that kind when `agentAlive` found exactly this
      // identity+inventory pairing 'alive') — audited below, never silently skipped, in case
      // that invariant is ever violated by a future change.
      throw new Error('controller_identity_unavailable_for_survived_agent')
    }
    db.refreshAgentHandleAfterRespawn({
      hostId,
      paneKey: launchRow.pane_key,
      newTerminalHandle: controllerIdentity.handle,
      processIncarnation,
      agentId
    })
    deps.notifyRebindDelivery(agentId)
  } catch (err) {
    auditSweepNote(
      db,
      hostId,
      launchRow.pane_key,
      agentId,
      `daemon_survived_refresh_failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return { kind: 'skipped_daemon_survived' }
}
