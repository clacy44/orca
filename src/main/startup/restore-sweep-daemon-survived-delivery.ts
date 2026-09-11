// S10-21c B5 (design §2 S7): the `skipped_daemon_survived` arm's own audit + handle-refresh +
// mail-arm step, split out of restore-registered-agent-panes.ts to stay under the max-lines
// ratchet (the module was already at its 300-line cap).
import type { AgentLaunchSessionRow } from '../runtime/orchestration/agent-launch-sessions'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import {
  parseProcessIncarnation,
  type ControllerInventory
} from '../runtime/orchestration/agent-process-identity'
import type { EarlyRowsDecision } from '../runtime/orchestration/restore-sweep-decision'
import { auditSweepSkip, auditSweepNote } from '../runtime/orchestration/restore-sweep-audit'
import type { RestoreSweepDeps, RestoreOneOutcome } from './restore-sweep-types'

/** [S10-21c B5, design §2 S7] The daemon kept this pane's pty alive across the restart — the
 * PROCESS needs nothing, but mail already queued against `agent:<id>` is still parked (R5), and
 * a pact paused `counterpart_gone` against this agent is still stuck (D-R150 F1; the same
 * un-pause the successful-restore arm performs, restore-registered-agent-panes.ts:276-280).
 * Audits the skip, then refreshes `terminal_handle` from the SAME controller-inventory identity
 * `decideEarlyRows` already used to reach 'alive' (`inventory.terminalIdentityByPtyId`, never a
 * redundant lookup), resumes any pacts the refresh reports post-commit, and arms delivery — all
 * bound to THIS candidate's own `agentId` (never re-derived by pane suffix, which two rows can
 * share). [D-R150 low 1, widened B3c D-R151 LOW 1] THREE separate try/catches, not one: a throw
 * from the refresh becomes `daemon_survived_refresh_failed:` and returns early (the refresh's own
 * outcome is now unknown, so pact resume and delivery must not run on top of it); a throw from
 * `db.resumePactsForRestoredAgent` — a SEPARATE try, placed after the refresh try, so it can never
 * mislabel itself a refresh failure — becomes its own `daemon_survived_pact_resume_failed:` and
 * does NOT return early, so a pact-resume failure can never suppress `notifyRebindDelivery`
 * (the R5 symptom S7 exists to cure); a throw from `notifyRebindDelivery` becomes
 * `delivery_notify_failed:` — the SAME code the successful-restore arm uses for that same call.
 * A typed `ok:false` refusal from the refresh (row already derived/tombstoned/quarantined, or no
 * longer registered) is not a throw — it is loudly noted too, carrying the refusal's own
 * `reason`, rather than silently arming delivery for a row the refresh declined to touch — and it
 * skips pact resume (there is nothing to resume against a refused refresh) while still falling
 * through to the delivery try. No half's failure is ever a failed skip — the skip itself already
 * committed. */
export function handleDaemonSurvivedSkip(
  db: OrchestrationDb,
  deps: RestoreSweepDeps,
  hostId: string,
  launchRow: AgentLaunchSessionRow,
  agentId: string,
  early: Extract<EarlyRowsDecision, { kind: 'skipped_daemon_survived' }>,
  processIncarnation: string | null,
  inventory: ControllerInventory | null
): RestoreOneOutcome {
  auditSweepSkip(db, hostId, launchRow.pane_key, agentId, early.reasonCode)
  let res: ReturnType<OrchestrationDb['refreshAgentHandleAfterRespawn']> | undefined
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
    res = db.refreshAgentHandleAfterRespawn({
      hostId,
      paneKey: launchRow.pane_key,
      newTerminalHandle: controllerIdentity.handle,
      processIncarnation,
      agentId,
      // [S10-21d R110] Records this pane's launch row afresh in the SAME transaction, evidence
      // 'daemon_survived', so sessionLaunchKnown does not go stale for a daemon-survived pane
      // (diag-r106-r110-2026-09-08.md).
      currentLaunchGeneration: deps.getLaunchGenerationId()
    })
    if (!res.ok) {
      auditSweepNote(
        db,
        hostId,
        launchRow.pane_key,
        agentId,
        `daemon_survived_refresh_refused: ${res.reason}`
      )
    }
  } catch (err) {
    auditSweepNote(
      db,
      hostId,
      launchRow.pane_key,
      agentId,
      `daemon_survived_refresh_failed: ${err instanceof Error ? err.message : String(err)}`
    )
    // A throw from the refresh means its own outcome is unknown — never proceed to pact resume
    // or delivery on an uncertain refresh.
    return { kind: 'skipped_daemon_survived' }
  }
  if (res !== undefined && res.ok) {
    // [S10-21d D-R162 M-2] Post-commit, same as recordLaunch's own wrapper and
    // rebindRestoredPane (agent-restore-rebind.ts:437-438): without this, a pane surviving N
    // daemon restarts accumulates N+1 launch rows, violating PRUNE_PER_PANE. Self-transacting,
    // never inside refreshAgentHandleAfterRespawn's own transaction (already closed above).
    db.pruneLaunchRowRetention(hostId, launchRow.pane_key)
    try {
      // [S10-21c B3c, D-R151 LOW 1] Own try, placed AFTER the refresh try: a throw here must
      // never be labelled a refresh failure (the refresh already committed successfully) and
      // must never suppress the notifyRebindDelivery try below. Post-commit —
      // refreshAgentHandleAfterRespawn's own BEGIN IMMEDIATE/COMMIT already closed above;
      // resumePactsForRestoredAgent opens its own transaction per pact (D-R150 F1).
      db.resumePactsForRestoredAgent(agentId, res.pactsToUnpause, deps.federatedPactEmitRuntime)
    } catch (err) {
      auditSweepNote(
        db,
        hostId,
        launchRow.pane_key,
        agentId,
        `daemon_survived_pact_resume_failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  try {
    deps.notifyRebindDelivery(agentId)
  } catch (err) {
    auditSweepNote(
      db,
      hostId,
      launchRow.pane_key,
      agentId,
      `delivery_notify_failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  // [S10-21e review] Fire-and-forget, placed AFTER delivery so no code runs between the
  // committed handle refresh and delivery: the attach never blocks or throws into this arm.
  if (res !== undefined && res.ok) {
    const survivedPtyId = parseProcessIncarnation(processIncarnation)?.ptyId
    if (survivedPtyId) {
      const attachSurvivedPty = deps.attachSurvivedPty
      if (attachSurvivedPty) {
        void attachSurvivedPty(survivedPtyId).then(
          (attached) => {
            if (!attached) {
              console.warn(
                `[restore-sweep] survived pane attach failed pane=${launchRow.pane_key} pty=${survivedPtyId} reason=attach_refused`
              )
            }
          },
          (err) => {
            console.warn(
              `[restore-sweep] survived pane attach failed pane=${launchRow.pane_key} pty=${survivedPtyId} reason=attach_threw:${
                err instanceof Error ? err.message : String(err)
              }`
            )
          }
        )
      } else {
        console.warn(
          `[restore-sweep] survived pane attach failed pane=${launchRow.pane_key} pty=${survivedPtyId} reason=no_attach_dep`
        )
      }
    }
  }
  return { kind: 'skipped_daemon_survived' }
}
