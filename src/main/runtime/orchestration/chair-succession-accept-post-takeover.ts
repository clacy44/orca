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
  // G1 attempt-3 repair F5: the identity has already moved by the time any of this runs (N7) — a
  // DB fault that fails the step being audited (e.g. bindRun's SQLITE_BUSY) can fail this SAME
  // audit write too, and an unguarded throw here would still reject accept after the takeover.
  // Swallow it; the step's own `warnings.push` below is the caller-visible signal either way.
  const auditFailure = (outcome: string, err: unknown): void => {
    try {
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
    } catch {
      // best-effort — see above.
    }
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
  // G1 attempt-3 repair F8: `writeManifestLastSessionId` now reports every no-write path (null
  // session id, missing/unparseable manifest, absent chair entry) instead of returning silently —
  // ANY `ok: false` sets the flag, not just a thrown I/O error.
  let manifestWriteFailed = false
  try {
    const result = await writeManifestLastSessionId(
      deps.manifestPath,
      params.hostId,
      chair,
      params.callerSessionId
    )
    if (!result.ok) {
      auditFailure('manifest_write_failed', new Error(result.reason))
      manifestWriteFailed = true
      warnings.push('manifestWriteFailed')
    }
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
