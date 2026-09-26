// S10-22a G1 repair round (attempt 2), B6/N4/N8: split out of chair-succession-accept.ts (line
// ratchet) — closes the incumbent pane and bounds the wait for its PTY to actually exit before
// the dead-pane takeover reads liveness.
// S10-22b W-D1-DR1: neither a resolved exit wait nor a non-timeout rejection proves the
// incumbent is dead. The controller's synthetic kill exit (`pty.ts:5866`) clears the liveness
// flags before the process actually dies; the takeover's own inventory round
// (`orca-runtime.ts:33774-33784`) or late output (`:11369-11371`) sets them again, and the real
// exit is discarded as a duplicate (`pty.ts:4254`). `confirmIncumbentDead` below is the only
// thing either branch may trust: it re-runs a REQUIRED, fresh controller-inventory round and
// reads the takeover's own dead-holder predicate immediately after it, under one shared bound.
import { transition, type ChairSuccessionStoreDeps } from './chair-succession-store'
import { OrchestrationError } from './orchestration-error'
import type { ChairSuccessionDeps } from './chair-succession-execute'
import type { HoldRecord } from './chair-succession-hold'
import { settleHold } from './chair-succession-hold'

export const INCUMBENT_EXIT_TIMEOUT_MS = 10_000
const INCUMBENT_DEATH_POLL_INTERVAL_MS = 500

function storeDepsFor(deps: ChairSuccessionDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
}

/** W-D1-DR1 FIX SPEC F1 (+ D2: scope the inventory round to the incumbent's own connection when
 * known, so one unreachable SSH provider cannot null a local succession's confirmation — falls
 * back to the global round when the connection is unknown). Neither a resolved exit wait nor a
 * non-timeout rejection proves the incumbent dead by itself (see header) — this is the only
 * check either caller may trust. */
export async function confirmIncumbentDead(
  deps: ChairSuccessionDeps,
  incumbentPaneKey: string,
  deadline: number
): Promise<boolean> {
  for (;;) {
    let inventoryFresh = false
    try {
      // The same inventory round registerAgentForPane's findLiveTerminalByHandle runs;
      // requireFreshPtyLiveness throws on a null/superseded round (orca-runtime.ts:18057).
      inventoryFresh = await deps.runtime.refreshPtyLivenessScopedToPane(incumbentPaneKey)
      if (!inventoryFresh) {
        await deps.runtime.listTerminals(undefined, undefined, { requireFreshPtyLiveness: true })
        inventoryFresh = true
      }
    } catch {
      inventoryFresh = false
    }
    if (inventoryFresh) {
      const signals = deps.runtime.getAgentDirectoryLivenessSignals(incumbentPaneKey)
      if (signals.terminalHandle === null && !signals.observedLive) {
        return true
      }
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, INCUMBENT_DEATH_POLL_INTERVAL_MS))
  }
}

/** Act (D-R215 §Protocol step 6) part 1: close the incumbent FIRST — the dead-pane takeover
 * depends on its pane no longer being live — then bound the wait for its PTY to actually exit.
 * On an unconfirmed-dead outcome (a real `timeout`, or a non-timeout rejection `confirmIncumbentDead`
 * still reads live), aborts the record, settles the hold, and throws
 * `succession_incumbent_exit_timeout` (N8: tells the SUCCESSOR pane, the one reading this error,
 * to stand down rather than implying `orca chairs restore` would help). On confirmed-dead, returns
 * the SAME deadline `confirmIncumbentDead` was bound by (W-D1-DR1 F2) — `chair-succession-accept.ts`
 * reuses it to bound a `name_taken` retry loop without a second, independent bound. */
export async function closeIncumbentAndWaitForExit(
  deps: ChairSuccessionDeps,
  hold: HoldRecord,
  chair: string,
  params: { successionId: string; callerPaneKey: string; hostId: string }
): Promise<number> {
  try {
    await deps.runtime.closeTerminal(hold.incumbent.terminalHandle)
  } catch {
    // best-effort — the incumbent pane may already be gone (e.g. it crashed mid-hold).
  }

  const deadline = Date.now() + INCUMBENT_EXIT_TIMEOUT_MS
  let waitError: unknown = null
  try {
    await deps.runtime.waitForTerminal(hold.incumbent.terminalHandle, {
      condition: 'exit',
      timeoutMs: INCUMBENT_EXIT_TIMEOUT_MS
    })
  } catch (err) {
    waitError = err
  }
  const timedOut =
    waitError !== null &&
    (waitError instanceof Error ? waitError.message : String(waitError)) === 'timeout'
  // W-D1-DR1 F1: a RESOLVED exit wait does not by itself prove the incumbent dead either — the
  // synthetic kill exit that resolves it fires before the process actually dies (see header) — so
  // confirmIncumbentDead runs for both the resolved and the non-timeout-rejected outcome. A real
  // `timeout` has already exhausted the bound, so there is nothing left to poll.
  const confirmedDead = timedOut
    ? false
    : await confirmIncumbentDead(deps, hold.incumbent.paneKey, deadline)
  if (confirmedDead) {
    // Confirmed dead via a fresh inventory round + the liveness predicate — proceed.
    return deadline
  }
  return abortForIncumbentExitTimeout(deps, chair, params)
}

/** N2 (G1-10z1 attempt-2 review): the exit-timeout abort tail, shared by two callers that both
 * mean the same thing (the incumbent still reads live within the bound) — the wait/confirm above,
 * and `chair-succession-accept.ts`'s F2 retry loop when its own re-confirm after a `name_taken`
 * comes back unconfirmed-dead. Always throws. */
export async function abortForIncumbentExitTimeout(
  deps: ChairSuccessionDeps,
  chair: string,
  params: { successionId: string; callerPaneKey: string; hostId: string }
): Promise<never> {
  await transition(storeDepsFor(deps), chair, params.successionId, 'aborted', {
    abortReason: 'incumbent_exit_timeout'
  })
  // H6 (G1-10z attempt-4): guarded — a throwing audit here must not skip the settle/stand-down
  // throw below. Unguarded, the successor got a raw DB error instead of the "stand down" the
  // caller depends on to decide it is not the chair.
  try {
    deps.db.writeAgentAudit({
      agentId: null,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.hostId,
      verb: 'succession_abort',
      outcome: 'aborted',
      reasonCode: `succession=${params.successionId} reason=incumbent_exit_timeout`.slice(0, 200)
    })
  } catch {
    // best-effort — see above.
  }
  settleHold(params.successionId, {
    ok: false,
    code: 'succession_aborted',
    successionId: params.successionId,
    reason: 'incumbent_exit_timeout'
  })
  throw new OrchestrationError(
    'succession_incumbent_exit_timeout',
    `The incumbent pane did not exit within ${INCUMBENT_EXIT_TIMEOUT_MS}ms. This succession was aborted; stand down — do not act as chair "${chair}" from this pane.`,
    {
      nextSteps: [
        'stand down: this pane is not the chair — do not send or receive chair traffic from it',
        'ask the incumbent (or a human) to check whether the old pane is actually dead',
        'if the old pane later dies on its own, nobody holds the chair: recover with `orca chairs restore`, run twice at least 10 s apart, then retry `orca chairs succeed` from the restored chair'
      ]
    }
  )
}
