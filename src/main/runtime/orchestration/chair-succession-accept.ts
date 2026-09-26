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
import { transition, type ChairSuccessionStoreDeps } from './chair-succession-store'
import { OrchestrationError } from './orchestration-error'
import { registerAgentForPane } from './register-agent-for-pane'
import type { ChairSuccessionDeps } from './chair-succession-execute'
import { readManifestEntry } from './chair-succession-manifest-entry'
import { getHoldRecord, settleHold } from './chair-succession-hold'
import { purgeSuccessionsForChair } from './chair-succession-purge'
import { enterConfirming } from './chair-succession-accept-confirm-lock'
import {
  closeIncumbentAndWaitForExit,
  confirmIncumbentDead
} from './chair-succession-accept-exit-wait'
import { runPostTakeoverSteps } from './chair-succession-accept-post-takeover'

function storeDepsFor(deps: ChairSuccessionDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
}

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
  /** G1 repair N7: a step after the takeover (bindRun, retired-handle append, the `confirmed`
   * transition, the post-confirm purge) failed but was audited and swallowed rather than
   * thrown — the caller IS the new chair regardless; these name what to check manually. Absent
   * when every post-takeover step succeeded. */
  warnings?: string[]
  /** G1 repair N16: the manifest write (chairs.json's lastSessionId) failed — the successor is
   * ACCEPTED, but a reboot's `chairs restore` will resume the pre-succession session until this
   * is fixed by hand. Also present in `warnings` as `'manifestWriteFailed'`. */
  manifestWriteFailed?: boolean
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

  // Act (D-R215 §Protocol step 6): close the incumbent, bound the wait for it to actually exit
  // (G1 repair B6), and — on anything short of confirmed-dead (a real timeout, or a non-timeout
  // rejection the liveness predicate still calls live, N4) — abort + settle + throw, telling the
  // successor pane to stand down (N8). Sourced from the HOLD, never meta.json (B5).
  // W-D1-DR1 F2: the returned deadline bounds the `name_taken` retry loop below with the SAME
  // bound confirmIncumbentDead used, not a second independent one.
  const incumbentDeadline = await closeIncumbentAndWaitForExit(deps, hold, chair, params)

  const entry = await readManifestEntry(deps.manifestPath, chair).catch(() => undefined)

  // H2 (G1-10z attempt-4): a throw from the write itself (the DB upsert, or the `listTerminals`
  // it awaits) must reach the SAME abort/settle/succession_takeover_failed path as a refused
  // `{ ok: false }` — the incumbent's pane is already closed either way, so an uncaught throw
  // here left the record wedged `confirming` and the successor with a raw DB error (H2).
  let registration: Awaited<ReturnType<typeof registerAgentForPane>> | undefined
  let registrationThrowReason: string | undefined
  // [G1-10z R2-L2] a boolean, not the message string: `new Error('')` has an empty message, and
  // `registrationThrowReason && !registration` would then skip the re-read below even though a
  // throw did occur.
  let registrationThrew = false
  // W-D1-DR1 F2 (answers Q5): a `name_taken` right after a confirmed death can still be the same
  // resurrection race F1 guards against (an inventory round or late output can re-set the
  // liveness flags again between confirmIncumbentDead's read and this upsert) — retry within the
  // SAME bound instead of aborting a done takeover and stranding the chair. Re-confirming dead
  // between attempts (not just sleeping) means a genuinely still-live incumbent still aborts
  // promptly rather than spinning to the full bound. No transition happens in this loop, so the
  // record stays `confirming` throughout.
  for (;;) {
    try {
      registration = await registerAgentForPane(deps.db, deps.runtime, {
        paneKey: params.callerPaneKey,
        terminalHandle: params.callerTerminalHandle,
        processIncarnation: deps.runtime.getTerminalProcessIncarnation(params.callerTerminalHandle),
        displayName: chair,
        // G1 repair M6 / N15: pass the manifest's role through — `registerAgentForPane` writes
        // `role` unconditionally, so leaving this `undefined` erases the chair's role on every
        // takeover. N15: the manifest is not the only source — a chair whose role exists only on
        // its (incumbent) agents row must not lose it just because the manifest never set one.
        role:
          entry?.role ??
          deps.db.getAgentByPaneKey(params.hostId, hold.incumbent.paneKey)?.role ??
          undefined
      })
    } catch (err) {
      registrationThrew = true
      registrationThrowReason = err instanceof Error ? err.message : String(err)
    }
    if (
      registration &&
      !registration.ok &&
      registration.reason === 'name_taken' &&
      Date.now() < incumbentDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (!(await confirmIncumbentDead(deps, hold.incumbent.paneKey, incumbentDeadline))) {
        break
      }
      continue
    }
    break
  }
  // [G1-10z polish-recheck N2 repair] a throw can arrive AFTER `upsertAgentByPaneSuffix` already
  // committed the re-point (a post-upsert step inside `registerAgentForPane` — catch-up, the
  // `register` audit, the unread-mail read — can throw too). Routing every throw to the abort
  // path left the identity on the live successor while the record stayed `aborted`, the Run
  // stayed on the dead incumbent, and the manifest kept the pre-succession session (a restart no
  // longer converges). Re-read the row: if it landed on the caller's pane, the write committed —
  // continue into the post-takeover steps with a warning instead of aborting a done takeover.
  let takeoverCommittedDespiteThrow = false
  if (registrationThrew && !registration) {
    // [G1-10z R2-L3] the re-read itself can throw (e.g. a locked DB) — that must fall through to
    // the abort/settle path below, not escape raw and leave the hold wedged `confirming`.
    let postThrowRow: ReturnType<typeof deps.db.getAgentByName> | undefined
    try {
      postThrowRow = deps.db.getAgentByName(params.hostId, chair)
    } catch {
      postThrowRow = undefined
    }
    if (postThrowRow && postThrowRow.pane_key === params.callerPaneKey) {
      takeoverCommittedDespiteThrow = true
      registration = {
        ok: true,
        agent: postThrowRow,
        created: false,
        reMinted: true,
        repointedMessages: 0,
        pendingOnOldHandle: 0,
        unreadWaiting: 0,
        adoptedThreads: 0,
        blockedByQuarantinedPredecessor: false,
        pendingPeerQuestions: 0,
        unreadMailOnRetiredId: 0
      }
    }
  }
  if (!registration || !registration.ok) {
    // Chair review fix #3: the incumbent's pane is ALREADY closed at this point — leaving the
    // record `confirming` would let a later hold timeout no-op (already_terminal only fires for
    // `launching`), stranding the record forever. Abort it here instead.
    const failureReason = registration ? registration.reason : registrationThrowReason
    const abortReason = `takeover_failed_after_close:${failureReason}`.slice(0, 200)
    await transition(storeDepsFor(deps), chair, params.successionId, 'aborted', { abortReason })
    // H6 (G1-10z attempt-4): guarded — a throwing audit here must not skip the settle/throw below.
    try {
      deps.db.writeAgentAudit({
        agentId: null,
        actorPaneKey: params.callerPaneKey,
        actorHostId: params.hostId,
        verb: 'succession_abort',
        outcome: 'aborted',
        reasonCode: `succession=${params.successionId} reason=${abortReason}`.slice(0, 200)
      })
    } catch {
      // best-effort — see above.
    }
    settleHold(params.successionId, {
      ok: false,
      code: 'succession_aborted',
      successionId: params.successionId,
      reason: 'takeover_failed'
    })
    throw new OrchestrationError(
      'succession_takeover_failed',
      `Dead-pane takeover for chair "${chair}" failed: ${failureReason}.`,
      {
        nextSteps: [
          'the incumbent chair pane is already closed and this pane was NOT registered as the chair — do not send or receive chair traffic from it',
          'recover the chair with `orca chairs restore`, run twice at least 10 s apart; chairs.json still names the pre-succession session, so restore resumes the incumbent conversation in a new pane',
          'once the restored chair is up, end this session; the restored chair can retry `orca chairs succeed`'
        ]
      }
    )
  }

  // N7: the identity has already moved — a fresh chair agent row is registered and the
  // incumbent's pane is closed. From here on, nothing may throw past the caller: every step
  // (bindRun, the retired handle, the manifest write, the `confirmed` transition) is audited on
  // failure and folded into `warnings` instead, and ACCEPTED is still returned.
  const runId = hold.runId
  const { confirmedId, warnings, manifestWriteFailed } = await runPostTakeoverSteps(
    deps,
    hold,
    chair,
    params,
    registration.agent.id
  )
  // [G1-10z polish-recheck N2 repair] surface the committed-despite-throw case explicitly rather
  // than leaving it indistinguishable from a clean takeover.
  if (takeoverCommittedDespiteThrow) {
    warnings.push('takeoverCommittedDespiteThrow')
  }

  // Never actually reaches the incumbent (its pane is already closed) — released here only so
  // the held `succeed` Promise doesn't leak forever.
  settleHold(params.successionId, { ok: true, confirmed: true, successionId: params.successionId })

  // [G1-10z Q8 repair] Best-effort post-confirm purge (bounded old succession dirs + retired
  // handles for this chair) — a purge fault must never fail an already-confirmed succession.
  try {
    await purgeSuccessionsForChair(storeDepsFor(deps), chair)
  } catch (err) {
    // G1 attempt-3 repair F5: the audit write itself is best-effort here too — a throwing audit
    // must not turn a benign purge failure into a rejected accept after the takeover.
    try {
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
    } catch {
      // best-effort — see above.
    }
    warnings.push('purgeFailed')
  }

  // D-R219 (chair ruling, G1 repair M3): the "served" set is gone — accept ALWAYS returns the
  // resume context, regardless of whether the SessionStart hook already served it.
  // G1 attempt-3 repair F5: guarded — the identity has already moved (N7); an I/O fault reading
  // resume-context.md (missing/unreadable) must not reject accept after the takeover. Fold it
  // into warnings and return without `resumeContext` instead (already optional on AcceptResult).
  let resumeContextText: string | undefined
  try {
    resumeContextText = await readFile(
      join(deps.orcaHome, 'chairs', chair, 'successions', params.successionId, 'resume-context.md'),
      'utf8'
    )
  } catch (err) {
    try {
      deps.db.writeAgentAudit({
        agentId: registration.agent.id,
        actorPaneKey: params.callerPaneKey,
        actorHostId: params.hostId,
        verb: 'succession_confirm',
        outcome: 'resume_context_read_failed',
        reasonCode:
          `succession=${params.successionId} ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            200
          )
      })
    } catch {
      // best-effort — see above.
    }
    warnings.push('resumeContextReadFailed')
  }

  // S10-22a residual R238: read-only accessors (same pair chair-succession-execute.ts's seal path
  // uses) against the successor's OWN mailbox/run, taken after the takeover above — anything
  // still outstanding here arrived on/after the handoff, so the successor (not the acked-at-seal
  // set) owns it.
  // H4 (G1-10z attempt-4): these ran unguarded — a DB fault here threw a raw error although the
  // record is already `confirmed` and the identity has already moved (N7 applies here too).
  const successorMailbox = `agent:${registration.agent.id}`
  let outstandingDeliveryIds: string[] = []
  try {
    const outstandingMailbox = deps.db.getOutstandingMailboxDelivery(successorMailbox)
    const outstandingRun = runId ? deps.db.getOutstandingRunDelivery(runId) : undefined
    outstandingDeliveryIds = [outstandingMailbox?.id, outstandingRun?.id].filter(
      (id): id is string => id !== undefined
    )
  } catch (err) {
    try {
      deps.db.writeAgentAudit({
        agentId: registration.agent.id,
        actorPaneKey: params.callerPaneKey,
        actorHostId: params.hostId,
        verb: 'succession_confirm',
        outcome: 'outstanding_delivery_read_failed',
        reasonCode:
          `succession=${params.successionId} ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            200
          )
      })
    } catch {
      // best-effort — see above.
    }
    warnings.push('outstandingDeliveryReadFailed')
  }

  const obligations: AcceptObligations = {
    ackedDeliveryIds: confirmingMeta.ackedDeliveryIds ?? [],
    outstandingDeliveryIds,
    retiredHandle: hold.incumbent.terminalHandle,
    pendingPeerQuestionThreadIds: [],
    pactTurnsHeld: 0
  }

  let generation = 0
  try {
    generation = runId ? (deps.db.getRun(runId)?.consumer_generation ?? 0) : 0
  } catch (err) {
    try {
      deps.db.writeAgentAudit({
        agentId: registration.agent.id,
        actorPaneKey: params.callerPaneKey,
        actorHostId: params.hostId,
        verb: 'succession_confirm',
        outcome: 'run_generation_read_failed',
        reasonCode:
          `succession=${params.successionId} ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            200
          )
      })
    } catch {
      // best-effort — see above.
    }
    warnings.push('runGenerationReadFailed')
  }

  return {
    ok: true,
    successionId: confirmedId,
    chair,
    agentId: registration.agent.id,
    runId: runId ?? '',
    generation,
    ...(resumeContextText !== undefined ? { resumeContext: resumeContextText } : {}),
    obligations,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(manifestWriteFailed ? { manifestWriteFailed: true } : {})
  }
}
