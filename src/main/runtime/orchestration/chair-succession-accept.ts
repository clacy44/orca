// S10-22a WAVE 2 (D-R215 §Protocol steps 5/6): `orchestration.chairs.successionAccept`'s whole
// body — proving the successor, then the confirm ("Act") tail: close the incumbent, the EXISTING
// dead-pane takeover, `bindRun` + waiter cancel, the retired handle, the manifest write, and
// releasing the incumbent's held `succeed` call (never actually answered — its pane is dead by
// the time this returns).
//
// G1 repair B5: every identity fact this file acts on — incumbent pane/handle, chair name, Run id
// — comes from `chair-succession-hold.ts`'s in-process `getHoldRecord`, never from `meta.json`
// (an on-disk file a same-uid writer could plant at any validly-shaped id path). `meta.json` is
// read only AFTER a hold is confirmed to exist for the id, and only for fields the hold does not
// itself carry (state, createdAt, successor pane, acked delivery ids).
//
// G1 repair B3: the confirming transition happens UNDER `chairLockKey(hold.chair)`, released
// BEFORE closing the incumbent — `chair-succession-hold.ts`'s `runAbortTail` takes the identical
// lock and re-reads state inside it, so the two can never both act on the same record.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  transition,
  appendRetiredHandle,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import { OrchestrationError } from './orchestration-error'
import { registerAgentForPane } from './register-agent-for-pane'
import type { ChairSuccessionDeps } from './chair-succession-execute'
import { readManifestEntry } from './chair-succession-manifest-entry'
import { getHoldRecord, settleHold } from './chair-succession-hold'
import { refreshRetiredHandlesIndexSync } from './chair-succession-retired-index'
import { purgeSuccessionsForChair } from './chair-succession-purge'
import { writeManifestLastSessionId } from './chair-succession-manifest-session-write'
import { enterConfirming } from './chair-succession-accept-confirm-lock'

function storeDepsFor(deps: ChairSuccessionDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
}

// G1 repair B6: bounded wait for the incumbent's PTY to actually exit before the dead-pane
// takeover reads liveness — `closeTerminal` returns as soon as the kill is issued, not once the
// process has actually gone (orca-runtime.ts's async exit handler sets `connected = false` later).
const INCUMBENT_EXIT_TIMEOUT_MS = 10_000

export type AcceptParams = {
  successionId: string
  callerPaneKey: string
  callerTerminalHandle: string
  callerSessionId: string | null
  hostId: string
}

export type AcceptObligations = {
  ackedDeliveryIds: string[]
  outstandingDeliveryIds: string[]
  retiredHandle: string | null
  /** Slice 1: peer-question threads are not tracked by succession yet — always empty. */
  pendingPeerQuestionThreadIds: string[]
  /** Slice 1: pact turn-holding is not tracked by succession yet — always 0. */
  pactTurnsHeld: number
}

export type AcceptResult = {
  ok: true
  successionId: string
  chair: string
  agentId: string
  runId: string
  generation: number
  resumeContext?: string
  obligations: AcceptObligations
}

/** D-R215 §Protocol step 5 "the successor's accept call must arrive from the new pane with its
 * host-minted session id" + step 6 (Act). Every refusal before the confirming-transition mutates
 * nothing; every refusal AFTER it (takeover failure, run moved, exit timeout) aborts the record
 * and settles the hold directly rather than leaving it to the 150 s timer. */
export async function acceptSuccession(
  deps: ChairSuccessionDeps,
  params: AcceptParams
): Promise<AcceptResult> {
  const hold = getHoldRecord(params.successionId)
  if (!hold) {
    throw new OrchestrationError(
      'succession_unknown',
      `No live hold for succession ${params.successionId}.`
    )
  }
  const chair = hold.chair

  const confirmingMeta = await enterConfirming(
    deps,
    hold,
    params.successionId,
    params.callerPaneKey
  )

  // Act (D-R215 §Protocol step 6). Close the incumbent FIRST — the dead-pane takeover below
  // depends on its pane no longer being live. Sourced from the HOLD, never meta.json (B5).
  try {
    await deps.runtime.closeTerminal(hold.incumbent.terminalHandle)
  } catch {
    // best-effort — the incumbent pane may already be gone (e.g. it crashed mid-hold).
  }

  // G1 repair B6: wait for the PTY to actually exit, bounded — never report success on a takeover
  // racing a still-live incumbent.
  try {
    await deps.runtime.waitForTerminal(hold.incumbent.terminalHandle, {
      condition: 'exit',
      timeoutMs: INCUMBENT_EXIT_TIMEOUT_MS
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'timeout') {
      await transition(storeDepsFor(deps), chair, params.successionId, 'aborted', {
        abortReason: 'incumbent_exit_timeout'
      })
      deps.db.writeAgentAudit({
        agentId: null,
        actorPaneKey: params.callerPaneKey,
        actorHostId: params.hostId,
        verb: 'succession_abort',
        outcome: 'aborted',
        reasonCode: `succession=${params.successionId} reason=incumbent_exit_timeout`.slice(0, 200)
      })
      settleHold(params.successionId, {
        ok: false,
        code: 'succession_aborted',
        successionId: params.successionId,
        reason: 'incumbent_exit_timeout'
      })
      throw new OrchestrationError(
        'succession_incumbent_exit_timeout',
        `The incumbent pane did not exit within ${INCUMBENT_EXIT_TIMEOUT_MS}ms; the successor pane is left open for manual recovery (orca chairs restore).`
      )
    }
    // terminal_handle_stale / terminal_exited / already-gone — treat as exited, proceed.
  }

  const entry = await readManifestEntry(deps.manifestPath, chair).catch(() => undefined)

  const registration = await registerAgentForPane(deps.db, deps.runtime, {
    paneKey: params.callerPaneKey,
    terminalHandle: params.callerTerminalHandle,
    processIncarnation: deps.runtime.getTerminalProcessIncarnation(params.callerTerminalHandle),
    displayName: chair,
    // G1 repair M6: pass the manifest's role through — `registerAgentForPane` writes `role`
    // unconditionally, so leaving this `undefined` erases the chair's role on every takeover.
    role: entry?.role
  })
  if (!registration.ok) {
    // Chair review fix #3: the incumbent's pane is ALREADY closed at this point — leaving the
    // record `confirming` would let a later hold timeout no-op (already_terminal only fires for
    // `launching`), stranding the record forever. Abort it here instead.
    const abortReason = `takeover_failed_after_close:${registration.reason}`.slice(0, 200)
    await transition(storeDepsFor(deps), chair, params.successionId, 'aborted', { abortReason })
    deps.db.writeAgentAudit({
      agentId: null,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.hostId,
      verb: 'succession_abort',
      outcome: 'aborted',
      reasonCode: `succession=${params.successionId} reason=${abortReason}`.slice(0, 200)
    })
    settleHold(params.successionId, {
      ok: false,
      code: 'succession_aborted',
      successionId: params.successionId,
      reason: 'takeover_failed'
    })
    throw new OrchestrationError(
      'succession_takeover_failed',
      `Dead-pane takeover for chair "${chair}" failed: ${registration.reason}.`
    )
  }

  const runId = hold.runId
  if (runId) {
    deps.db.bindRun({
      runId,
      coordinatorHandle: params.callerTerminalHandle,
      coordinatorPaneKey: params.callerPaneKey
    })
    deps.runtime.cancelMessageWaiters(`run:${runId}`)
  }

  await appendRetiredHandle(storeDepsFor(deps), chair, {
    handle: hold.incumbent.terminalHandle,
    succession: params.successionId,
    at: new Date().toISOString()
  })
  refreshRetiredHandlesIndexSync(deps.orcaHome)

  // G1 repair M5: BEFORE `confirmed`, and never allowed to throw past it — a manifest I/O hiccup
  // must not strand a successfully-taken-over successor with neither ACCEPTED nor context.
  try {
    await writeManifestLastSessionId(
      deps.manifestPath,
      params.hostId,
      chair,
      params.callerSessionId
    )
  } catch (err) {
    deps.db.writeAgentAudit({
      agentId: registration.agent.id,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.hostId,
      verb: 'succession_confirm',
      outcome: 'manifest_write_failed',
      reasonCode:
        `succession=${params.successionId} ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          200
        )
    })
  }

  const confirmed = await transition(storeDepsFor(deps), chair, params.successionId, 'confirmed', {
    retiredHandle: hold.incumbent.terminalHandle
  })

  deps.db.writeAgentAudit({
    agentId: registration.agent.id,
    actorPaneKey: params.callerPaneKey,
    actorHostId: params.hostId,
    verb: 'succession_confirm',
    outcome: 'confirmed',
    reasonCode: `succession=${params.successionId}`.slice(0, 200)
  })

  // Never actually reaches the incumbent (its pane is already closed) — released here only so
  // the held `succeed` Promise doesn't leak forever.
  settleHold(params.successionId, { ok: true, confirmed: true, successionId: params.successionId })

  // [G1-10z Q8 repair] Best-effort post-confirm purge (bounded old succession dirs + retired
  // handles for this chair) — a purge fault must never fail an already-confirmed succession.
  try {
    await purgeSuccessionsForChair(storeDepsFor(deps), chair)
  } catch (err) {
    deps.db.writeAgentAudit({
      agentId: registration.agent.id,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.hostId,
      verb: 'succession_confirm',
      outcome: 'purge_failed',
      reasonCode:
        `succession=${params.successionId} ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          200
        )
    })
  }

  // D-R219 (chair ruling, G1 repair M3): the "served" set is gone — accept ALWAYS returns the
  // resume context, regardless of whether the SessionStart hook already served it.
  const resumeContextText = await readFile(
    join(deps.orcaHome, 'chairs', chair, 'successions', params.successionId, 'resume-context.md'),
    'utf8'
  )

  // S10-22a residual R238: read-only accessors (same pair chair-succession-execute.ts's seal path
  // uses) against the successor's OWN mailbox/run, taken after the takeover above — anything
  // still outstanding here arrived on/after the handoff, so the successor (not the acked-at-seal
  // set) owns it.
  const successorMailbox = `agent:${registration.agent.id}`
  const outstandingMailbox = deps.db.getOutstandingMailboxDelivery(successorMailbox)
  const outstandingRun = runId ? deps.db.getOutstandingRunDelivery(runId) : undefined
  const outstandingDeliveryIds = [outstandingMailbox?.id, outstandingRun?.id].filter(
    (id): id is string => id !== undefined
  )

  const obligations: AcceptObligations = {
    ackedDeliveryIds: confirmingMeta.ackedDeliveryIds ?? [],
    outstandingDeliveryIds,
    retiredHandle: hold.incumbent.terminalHandle,
    pendingPeerQuestionThreadIds: [],
    pactTurnsHeld: 0
  }

  return {
    ok: true,
    successionId: confirmed.id,
    chair,
    agentId: registration.agent.id,
    runId: runId ?? '',
    generation: runId ? (deps.db.getRun(runId)?.consumer_generation ?? 0) : 0,
    resumeContext: resumeContextText,
    obligations
  }
}
