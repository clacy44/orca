// S10-22a G1 repair round (attempt 2), N7/N16: split out of chair-succession-accept.ts (line
// ratchet) — every step here runs AFTER the takeover has already moved the identity (a fresh
// chair agent row is registered, the incumbent's pane is closed): nothing may throw past the
// caller. Each step is audited on failure and folded into `warnings` instead of rejecting.
import {
  transition,
  appendRetiredHandle,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import type { ChairSuccessionDeps } from './chair-succession-execute'
import type { HoldRecord } from './chair-succession-hold'
import { refreshRetiredHandlesIndexSync } from './chair-succession-retired-index'
import { writeManifestLastSessionId } from './chair-succession-manifest-session-write'

function storeDepsFor(deps: ChairSuccessionDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
}

export type PostTakeoverParams = {
  successionId: string
  callerPaneKey: string
  callerTerminalHandle: string
  callerSessionId: string | null
  hostId: string
}

export type PostTakeoverResult = {
  confirmedId: string
  warnings: string[]
  manifestWriteFailed: boolean
}

/** bindRun + waiter cancel, the retired handle, the manifest write (G1 repair M5/N16), and the
 * `confirmed` transition — in that order, each independently guarded (G1 repair N7). */
export async function runPostTakeoverSteps(
  deps: ChairSuccessionDeps,
  hold: HoldRecord,
  chair: string,
  params: PostTakeoverParams,
  registeredAgentId: string
): Promise<PostTakeoverResult> {
  const warnings: string[] = []
  const auditFailure = (outcome: string, err: unknown): void => {
    deps.db.writeAgentAudit({
      agentId: registeredAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.hostId,
      verb: 'succession_confirm',
      outcome,
      reasonCode:
        `succession=${params.successionId} ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          200
        )
    })
  }

  const runId = hold.runId
  if (runId) {
    try {
      deps.db.bindRun({
        runId,
        coordinatorHandle: params.callerTerminalHandle,
        coordinatorPaneKey: params.callerPaneKey
      })
      deps.runtime.cancelMessageWaiters(`run:${runId}`)
    } catch (err) {
      auditFailure('run_bind_failed', err)
      warnings.push('runBindFailed')
    }
  }

  try {
    await appendRetiredHandle(storeDepsFor(deps), chair, {
      handle: hold.incumbent.terminalHandle,
      succession: params.successionId,
      at: new Date().toISOString()
    })
    refreshRetiredHandlesIndexSync(deps.orcaHome)
  } catch (err) {
    auditFailure('retired_handle_append_failed', err)
    warnings.push('retiredHandleAppendFailed')
  }

  // G1 repair M5 / N16: BEFORE `confirmed`, and never allowed to throw past it — a manifest I/O
  // hiccup must not strand a successfully-taken-over successor with neither ACCEPTED nor context.
  // Surfaced as a warning (not just an audit row) — silence here left the next reboot's
  // `chairs restore` resuming the pre-succession incumbent session.
  let manifestWriteFailed = false
  try {
    await writeManifestLastSessionId(
      deps.manifestPath,
      params.hostId,
      chair,
      params.callerSessionId
    )
  } catch (err) {
    auditFailure('manifest_write_failed', err)
    manifestWriteFailed = true
    warnings.push('manifestWriteFailed')
  }

  // N7: a lock-wait timeout here must not strand the record `confirming` forever without at
  // least telling the caller — fall back to the params-derived id on failure so the caller can
  // still build a result.
  let confirmedId = params.successionId
  try {
    const confirmed = await transition(
      storeDepsFor(deps),
      chair,
      params.successionId,
      'confirmed',
      {
        retiredHandle: hold.incumbent.terminalHandle
      }
    )
    confirmedId = confirmed.id
    deps.db.writeAgentAudit({
      agentId: registeredAgentId,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.hostId,
      verb: 'succession_confirm',
      outcome: 'confirmed',
      reasonCode: `succession=${params.successionId}`.slice(0, 200)
    })
  } catch (err) {
    auditFailure('confirm_transition_failed', err)
    warnings.push('confirmTransitionFailed')
  }

  return { confirmedId, warnings, manifestWriteFailed }
}
