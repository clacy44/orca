// S10-22a G1 repair round (attempt 2), B6/N4/N8: split out of chair-succession-accept.ts (line
// ratchet) — closes the incumbent pane and bounds the wait for its PTY to actually exit before
// the dead-pane takeover reads liveness. `closeTerminal` returns as soon as the kill is issued,
// not once the process has actually gone (orca-runtime.ts's async exit handler sets
// `connected = false` later).
import { transition, type ChairSuccessionStoreDeps } from './chair-succession-store'
import { OrchestrationError } from './orchestration-error'
import type { ChairSuccessionDeps } from './chair-succession-execute'
import type { HoldRecord } from './chair-succession-hold'
import { settleHold } from './chair-succession-hold'

export const INCUMBENT_EXIT_TIMEOUT_MS = 10_000
const INCUMBENT_LIVENESS_POLL_INTERVAL_MS = 100

function storeDepsFor(deps: ChairSuccessionDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
}

/** G1 repair N4: `waitForTerminal`'s `exit` condition can reject for reasons OTHER than a real
 * PTY exit — a renderer graph sync dropping the leaf, a renderer reload, the graph becoming
 * unavailable — all surfaced as e.g. `terminal_handle_stale`, not `timeout`. None of those prove
 * the process actually died. Poll the takeover's OWN liveness predicate (no connected handle,
 * never observed live) under the same bound before trusting the rejection. */
async function waitForIncumbentDeath(
  deps: ChairSuccessionDeps,
  incumbentPaneKey: string,
  boundMs: number
): Promise<boolean> {
  const deadline = Date.now() + boundMs
  for (;;) {
    const signals = deps.runtime.getAgentDirectoryLivenessSignals(incumbentPaneKey)
    if (signals.terminalHandle === null && !signals.observedLive) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, INCUMBENT_LIVENESS_POLL_INTERVAL_MS))
  }
}

/** Act (D-R215 §Protocol step 6) part 1: close the incumbent FIRST — the dead-pane takeover
 * depends on its pane no longer being live — then bound the wait for its PTY to actually exit.
 * On an unconfirmed-dead outcome (a real `timeout`, or a non-timeout rejection the liveness
 * predicate still calls live — N4), aborts the record, settles the hold, and throws
 * `succession_incumbent_exit_timeout` (N8: tells the SUCCESSOR pane, the one reading this error,
 * to stand down rather than implying `orca chairs restore` would help). Returns normally once the
 * incumbent is confirmed dead. */
export async function closeIncumbentAndWaitForExit(
  deps: ChairSuccessionDeps,
  hold: HoldRecord,
  chair: string,
  params: { successionId: string; callerPaneKey: string; hostId: string }
): Promise<void> {
  try {
    await deps.runtime.closeTerminal(hold.incumbent.terminalHandle)
  } catch {
    // best-effort — the incumbent pane may already be gone (e.g. it crashed mid-hold).
  }

  try {
    await deps.runtime.waitForTerminal(hold.incumbent.terminalHandle, {
      condition: 'exit',
      timeoutMs: INCUMBENT_EXIT_TIMEOUT_MS
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // N4: a non-`timeout` rejection (terminal_handle_stale etc.) does not by itself prove the
    // incumbent exited — confirm against the takeover's own liveness predicate before trusting
    // it. A `timeout` rejection has already exhausted the bound, so there is nothing left to poll.
    const confirmedDead =
      message === 'timeout'
        ? false
        : await waitForIncumbentDeath(deps, hold.incumbent.paneKey, INCUMBENT_EXIT_TIMEOUT_MS)
    if (confirmedDead) {
      // Confirmed dead via the liveness predicate — proceed with the takeover.
      return
    }
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
          'once confirmed dead, a fresh `orca chairs succeed` from the incumbent (if reachable) or manual recovery can retry'
        ]
      }
    )
  }
}
